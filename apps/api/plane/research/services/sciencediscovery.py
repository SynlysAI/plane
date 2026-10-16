"""Backend-only ScienceDiscovery client for projects, sessions and run cursors."""

import httpx
from django.conf import settings

from plane.license.utils.encryption import decrypt_data
from plane.research.services.backend_connections import (
    BackendConnectionError,
    resolve_validated_backend_request_url,
)


class ScienceDiscoveryErrorCode:
    """Stable error codes surfaced to the Research Agent BFF."""

    NOT_CONFIGURED = "science_discovery_not_configured"
    PROJECT_FAILED = "science_discovery_project_failed"
    SESSION_FAILED = "science_discovery_session_failed"
    RUN_FAILED = "science_discovery_run_failed"
    EVENT_CURSOR_FAILED = "science_discovery_event_cursor_failed"


class ScienceDiscoveryError(Exception):
    """A fail-closed ScienceDiscovery orchestration error."""

    def __init__(self, code, message, status_code=503):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class ScienceDiscoveryClient:
    """Talk to one ScienceDiscovery adapter (default ``http://127.0.0.1:5300``).

    The bearer token never crosses the browser: the BFF is the only caller.
    """

    def __init__(self, connection=None):
        """Build a client from one user backend connection (the only source).

        Args:
            connection: The ``ResearchAgentBackendConnection`` created from the
                settings UI. Without a connection the client stays unconfigured.
        """
        raw_base_url = str(connection.base_url or "").rstrip("/") if connection is not None else ""
        if raw_base_url:
            try:
                self.base_url = resolve_validated_backend_request_url(raw_base_url)
            except BackendConnectionError:
                # Runtime policy drift must fail closed instead of falling back
                # to the user-supplied URL saved under an older deployment.
                self.base_url = ""
        else:
            self.base_url = ""
        self.auth_token = decrypt_data(connection.credential_encrypted or "") if connection is not None else ""
        self.timeout = float(getattr(settings, "SCIENCE_DISCOVERY_TIMEOUT_SECONDS", 10))

    @property
    def configured(self):
        """Whether a usable user connection is attached."""
        return bool(self.base_url and self.auth_token)

    def _headers(self):
        return {"Authorization": f"Bearer {self.auth_token}"}

    def _request(self, method, path, *, json_payload=None, params=None):
        if not self.configured:
            raise ScienceDiscoveryError(
                ScienceDiscoveryErrorCode.NOT_CONFIGURED,
                "ScienceDiscovery runtime is not configured.",
            )
        try:
            with httpx.Client(timeout=self.timeout, base_url=self.base_url) as client:
                response = client.request(
                    method,
                    path,
                    headers=self._headers(),
                    json=json_payload,
                    params=params,
                )
        except httpx.HTTPError as exc:
            raise ScienceDiscoveryError(
                ScienceDiscoveryErrorCode.NOT_CONFIGURED,
                "Local ScienceDiscovery runtime is unreachable.",
            ) from exc
        if response.status_code >= 400:
            detail = ""
            try:
                detail = str((response.json() or {}).get("error") or "")[:200]
            except ValueError:
                pass
            message = f"ScienceDiscovery returned {response.status_code}." + (f" {detail}" if detail else "")
            raise ScienceDiscoveryError(
                ScienceDiscoveryErrorCode.SESSION_FAILED,
                message,
                502 if response.status_code < 500 else 503,
            )
        return response.json()

    def upload_workspace_file(self, *, session_id, file_name, content):
        """Upload one file into an SD session workspace (multipart, §9 文件通道).

        Args:
            session_id: The SD session whose workspace receives the file.
            file_name: A plain basename; SD rejects path separators.
            content: Raw file bytes.

        Returns:
            The SD ``WorkspaceUploadResult`` dict.
        """
        if not self.configured:
            raise ScienceDiscoveryError(
                ScienceDiscoveryErrorCode.NOT_CONFIGURED,
                "ScienceDiscovery runtime is not configured.",
            )
        try:
            with httpx.Client(timeout=self.timeout, base_url=self.base_url) as client:
                response = client.post(
                    f"/api/sessions/{session_id}/workspace/upload",
                    headers=self._headers(),
                    files={"file": (file_name, content)},
                )
        except httpx.HTTPError as exc:
            raise ScienceDiscoveryError(
                ScienceDiscoveryErrorCode.NOT_CONFIGURED,
                "Local ScienceDiscovery runtime is unreachable.",
            ) from exc
        if response.status_code >= 400:
            raise ScienceDiscoveryError(
                ScienceDiscoveryErrorCode.SESSION_FAILED,
                f"ScienceDiscovery upload returned {response.status_code}.",
                502 if response.status_code < 500 else 503,
            )
        return response.json()

    def list_models(self):
        """List configured model profiles (also used as a connection health probe)."""
        payload = self._request("GET", "/api/models")
        return payload.get("models") if isinstance(payload, dict) else payload

    def create_project(self, *, name):
        """Create one SD project per Plane research project (lazy, first use)."""
        payload = self._request("POST", "/api/projects", json_payload={"name": name})
        project_id = str(payload.get("id") or "")
        if not project_id:
            raise ScienceDiscoveryError(
                ScienceDiscoveryErrorCode.PROJECT_FAILED,
                "ScienceDiscovery did not return a project id.",
                502,
            )
        return project_id

    def create_session(self, *, project_id, title, specialist_id=None):
        """Create one SD session mapped to one Plane Agent session."""
        payload = {"title": title}
        if specialist_id:
            payload["specialistId"] = specialist_id
        payload = self._request(
            "POST",
            f"/api/projects/{project_id}/sessions",
            json_payload=payload,
        )
        session_id = str(payload.get("id") or "")
        if not session_id:
            raise ScienceDiscoveryError(
                ScienceDiscoveryErrorCode.SESSION_FAILED,
                "ScienceDiscovery did not return a session id.",
                502,
            )
        return session_id

    def start_run(self, *, session_id, content):
        """Submit one message; SD queues it and returns the run id immediately."""
        payload = self._request(
            "POST",
            f"/api/sessions/{session_id}/runs",
            json_payload={"content": content},
        )
        run_id = str(payload.get("id") or "")
        if not run_id:
            raise ScienceDiscoveryError(
                ScienceDiscoveryErrorCode.RUN_FAILED,
                "ScienceDiscovery did not return a run id.",
                502,
            )
        return run_id

    def events(self, *, session_id, run_id, after_seq=0):
        """Pull the incremental run event page after one cursor position."""
        # SD 校验 after >= 0 且事件序号从 1 开始，0 即全量起点。
        payload = self._request(
            "GET",
            f"/api/sessions/{session_id}/runs/{run_id}/events",
            params={"after": after_seq},
        )
        if not isinstance(payload, list):
            raise ScienceDiscoveryError(
                ScienceDiscoveryErrorCode.EVENT_CURSOR_FAILED,
                "ScienceDiscovery returned a malformed event page.",
                502,
            )
        return payload

    def cancel(self, *, session_id, run_id):
        """Ask SD to cancel one queued or running run."""
        return self._request("POST", f"/api/sessions/{session_id}/runs/{run_id}/cancel")

    def answer_approval(self, *, request_id, decision):
        """Forward one human approval decision to the SD adapter.

        Args:
            request_id: The SD ``PermissionRequest.id`` from ``permission.required``.
            decision: One of ``allow_once`` / ``allow_matching`` / ``deny``.
        """
        # 上游 ScienceDiscovery 的决策路由；fyk_dev 旧适配层的
        # /agent/approvals/{id} 在原版 SD 上不存在（404 HTML）。
        return self._request(
            "POST",
            f"/api/permission-requests/{request_id}/decision",
            json_payload={"decision": decision},
        )

    def list_artifacts(self, *, session_id):
        """List artifacts produced in one SD session."""
        return self._request("GET", f"/api/sessions/{session_id}/artifacts")

    def list_specialists(self):
        """List SD specialists (built-in plus custom)."""
        return self._request("GET", "/api/specialists")

    def create_specialist(self, *, name, description, instructions):
        """Create one custom specialist from the Plane catalog."""
        return self._request(
            "POST",
            "/api/specialists",
            json_payload={
                "name": name,
                "description": description,
                "instructions": instructions,
            },
        )

    def update_specialist(self, *, specialist_id, name, description, instructions):
        """Update one custom specialist in place."""
        return self._request(
            "PUT",
            f"/api/specialists/{specialist_id}",
            json_payload={
                "name": name,
                "description": description,
                "instructions": instructions,
            },
        )

    def artifact_content(self, *, session_id, version_id):
        """Fetch one artifact version's bytes from the SD CAS store.

        Args:
            session_id: The SD session that produced the artifact.
            version_id: An artifact version id seen in this session's events.

        Returns:
            A tuple of ``(content_bytes, media_type)``.
        """
        if not self.configured:
            raise ScienceDiscoveryError(
                ScienceDiscoveryErrorCode.NOT_CONFIGURED,
                "ScienceDiscovery runtime is not configured.",
            )
        try:
            with httpx.Client(timeout=self.timeout, base_url=self.base_url) as client:
                response = client.get(
                    f"/api/sessions/{session_id}/artifact-versions/{version_id}/content",
                    headers=self._headers(),
                )
        except httpx.HTTPError as exc:
            raise ScienceDiscoveryError(
                ScienceDiscoveryErrorCode.NOT_CONFIGURED,
                "Local ScienceDiscovery runtime is unreachable.",
            ) from exc
        if response.status_code >= 400:
            raise ScienceDiscoveryError(
                ScienceDiscoveryErrorCode.SESSION_FAILED,
                f"ScienceDiscovery artifact fetch returned {response.status_code}.",
                502 if response.status_code < 500 else 503,
            )
        return response.content, response.headers.get("content-type", "application/octet-stream")
