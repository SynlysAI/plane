"""Backend-only Synlora client for delegated identity, sessions and cursors."""

import json

import httpx
from django.conf import settings


class SynloraErrorCode:
    NOT_CONFIGURED = "synlora_not_configured"
    ACCOUNT_LINK_INACTIVE = "synlora_account_link_inactive"
    DELEGATED_AUTH_FAILED = "synlora_delegated_auth_failed"
    CAPABILITY_FAILED = "synlora_capability_failed"
    SESSION_FAILED = "synlora_session_failed"
    MESSAGE_FAILED = "synlora_message_failed"
    EVENT_CURSOR_FAILED = "synlora_event_cursor_failed"


class SynloraError(Exception):
    """A fail-closed Synlora orchestration error."""

    def __init__(self, code, message, status_code=503):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


class SynloraClient:
    """Small synchronous client; delegated tokens never cross the browser."""

    def __init__(self):
        self.base_url = str(getattr(settings, "SYNLORA_BASE_URL", "")).rstrip("/")
        self.service_token = str(getattr(settings, "SYNLORA_SERVICE_TOKEN", ""))
        self.timeout = float(getattr(settings, "SYNLORA_TIMEOUT_SECONDS", 5))

    @property
    def configured(self):
        return bool(self.base_url and self.service_token)

    def _service_headers(self):
        return {"Authorization": f"Bearer {self.service_token}"}

    def _request(self, method, path, *, headers=None, json_payload=None, params=None):
        if not self.configured:
            raise SynloraError(SynloraErrorCode.NOT_CONFIGURED, "Synlora is not configured.")
        try:
            with httpx.Client(timeout=self.timeout, base_url=self.base_url) as client:
                response = client.request(method, path, headers=headers, json=json_payload, params=params)
        except httpx.HTTPError as exc:
            raise SynloraError(SynloraErrorCode.NOT_CONFIGURED, "Synlora is unavailable.") from exc
        if response.status_code >= 400:
            raise SynloraError(
                SynloraErrorCode.SESSION_FAILED,
                f"Synlora returned {response.status_code}.",
                502 if response.status_code < 500 else 503,
            )
        return response.json()

    def exchange_delegated_token(self, *, account_link, workspace, user):
        """Exchange an ACTIVE AccountLink for a short-lived Synlora user token."""
        return self._request(
            "POST",
            "/api/v1/research/delegated-token",
            headers=self._service_headers(),
            json_payload={
                "schema_version": "plane-delegated-auth.v1",
                "account_link_id": str(account_link.id),
                "workspace_id": str(workspace.id),
                "plane_user_id": str(user.id),
                "external_subject": account_link.external_subject,
            },
        )

    def capabilities(self, delegated_token):
        """Fetch the user-scoped capability manifest."""
        return self._request(
            "GET",
            "/api/v1/research/capabilities",
            headers={"Authorization": f"Bearer {delegated_token}"},
        )

    def create_session(self, *, delegated_token, context_token, payload):
        """Create a session carrying only v2 Context metadata."""
        return self._request(
            "POST",
            "/api/v1/sessions",
            headers={
                "Authorization": f"Bearer {delegated_token}",
                "X-Research-Context-Token": context_token,
            },
            json_payload=payload,
        )

    def send_message(
        self,
        *,
        delegated_token,
        session_id,
        context_token,
        context_metadata,
        content,
        request_id,
    ):
        """Run one message and collect its SSE events without exposing tokens."""
        if not self.configured:
            raise SynloraError(SynloraErrorCode.NOT_CONFIGURED, "Synlora is not configured.")
        events = []
        try:
            with httpx.Client(timeout=self.timeout, base_url=self.base_url) as client:
                with client.stream(
                    "POST",
                    f"/api/v1/sessions/{session_id}/messages",
                    headers={
                        "Authorization": f"Bearer {delegated_token}",
                        "X-Research-Context-Token": context_token,
                        "X-Request-Id": request_id,
                    },
                    json={"text": content, "research_context": context_metadata},
                ) as response:
                    if response.status_code >= 400:
                        raise SynloraError(
                            SynloraErrorCode.MESSAGE_FAILED,
                            f"Synlora message returned {response.status_code}.",
                            502 if response.status_code < 500 else 503,
                        )
                    for line in response.iter_lines():
                        if line.startswith("data:"):
                            raw = line[5:].strip()
                            if raw:
                                events.append(json.loads(raw))
        except SynloraError:
            raise
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise SynloraError(SynloraErrorCode.MESSAGE_FAILED, "Synlora message stream failed.") from exc
        return events

    def events(self, *, delegated_token, session_id, after_seq=-1):
        """Read one page after a stable event cursor."""
        return self._request(
            "GET",
            f"/api/v1/sessions/{session_id}/events",
            headers={"Authorization": f"Bearer {delegated_token}"},
            params={"after_seq": after_seq},
        )

    def cancel(self, *, delegated_token, run_id):
        """Stop a Synlora run."""
        return self._request(
            "POST",
            f"/api/v1/runs/{run_id}/cancel",
            headers={"Authorization": f"Bearer {delegated_token}"},
        )

    def close(self, *, delegated_token, session_id):
        """Close a Synlora session."""
        return self._request(
            "DELETE",
            f"/api/v1/sessions/{session_id}",
            headers={"Authorization": f"Bearer {delegated_token}"},
        )
