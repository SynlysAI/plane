# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Per system adapters (P1-D2 ~ P1-D4).

Each adapter declares the paths it talks to and how a payload maps onto the
shared reference shape. Field口径 differences stay inside the adapter so the
generic layer never learns about a single vendor.
"""

import base64
import hashlib
import hmac
import json
import time

from plane.db.models import ExternalSystemConnection

from .base import BaseIntegrationClient, resolve_secret


class RagPortalClient(BaseIntegrationClient):
    system = "RAGPORTAL"
    search_path = "/api/kb/list"
    upload_path = "/api/uploads"
    upload_detail_path = "/api/uploads/{upload_id}"
    visible_path = "/api/uploads/{external_id}"
    health_path = "/api/health"
    external_type = "KNOWLEDGE_ENTRY"
    operation = "fetch_knowledge_entries"

    def headers(self, *, path, query=""):
        """Build RAGPortal's AI4MS-compatible bearer token.

        Args:
            path: Request path; retained for the shared adapter signature.
            query: Serialized query string; retained for the shared adapter signature.

        Returns:
            Authentication headers for RAGPortal. Non-HMAC modes fall back to the
            generic integration contract.
        """
        if self.connection is None or self.connection.auth_mode != ExternalSystemConnection.AuthMode.HMAC:
            return super().headers(path=path, query=query)
        secret = resolve_secret(self.connection)
        if not secret:
            return {}
        now = int(time.time())
        payload = {
            "sub": "plane-research-bff",
            "username": "plane-research-bff",
            "role": "user",
            "iat": now,
            "exp": now + 300,
        }
        payload_b64 = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).rstrip(b"=").decode()
        signature = hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).hexdigest()
        return {"Authorization": f"Bearer {payload_b64}.{signature}"}

    def normalise(self, payload):
        """Normalise RAGPortal KB list and upload responses to references."""
        if isinstance(payload, dict) and "items" not in payload:
            payload = {"items": [payload]}
        return super().normalise(payload)

    def normalise_item(self, raw):
        """Normalise both KB entries and scoped upload receipts."""
        if not isinstance(raw, dict):
            return None
        if not (raw.get("knowledge_id") or raw.get("parse_status")):
            return super().normalise_item(raw)
        external_id = str(raw.get("knowledge_id") or raw.get("id") or "")
        if not external_id:
            return None
        upload_id = str(raw.get("id") or "")
        return {
            "external_id": external_id,
            "external_type": self.external_type,
            "external_parent_id": str(raw.get("kb_id") or raw.get("knowledge_base_id") or ""),
            "title": str(raw.get("file_name") or f"RAGPortal upload {upload_id or external_id}")[:500],
            "summary": str(raw.get("summary") or raw.get("parse_status") or "")[:2000],
            "source_url": str(raw.get("source_url") or (f"/api/uploads/{upload_id}" if upload_id else "")),
            "acl_hint": raw.get("acl") or raw.get("acl_hint") or {},
            "metadata": {
                "upload_id": upload_id,
                "task_id": raw.get("task_id") or raw.get("weknora_task_id") or "",
                "parse_status": raw.get("parse_status") or "",
                "file_hash": raw.get("file_hash") or "",
                "workspace_slug": raw.get("workspace_slug") or "",
                "research_project_id": raw.get("research_project_id") or "",
                "chain_node_id": raw.get("chain_node_id") or "",
            },
        }

    def knowledge_bases(self, *, refresh=False, request=None):
        """List KBs visible to the backend credential."""
        return self.request(path="/api/kb/list", params={"refresh": str(bool(refresh)).lower()}, operation="list_knowledge_bases", request=request)

    def upload(self, *, file_name, file_content, kb_id, metadata=None, request=None):
        """Upload a document with research scope metadata."""
        data = {"kb_id": str(kb_id)}
        data.update({key: str(value) for key, value in (metadata or {}).items() if value is not None})
        return self.request(
            path=self.upload_path,
            operation="upload_document",
            request=request,
            method="POST",
            data=data,
            files={"file": (file_name, file_content)},
        )

    def upload_detail(self, upload_id, *, request=None):
        """Poll one RAGPortal upload status."""
        return self.request(path=self.upload_detail_path.format(upload_id=upload_id), operation="get_upload_status", request=request)


class WeKnoraClient(RagPortalClient):
    """WeKnora exposes the same entry contract; only the base URL differs."""

    system = "WEKNORA"
    operation = "fetch_weknora_entries"


class SpecLabOSClient(BaseIntegrationClient):
    system = "SPECLABOS"
    search_path = "/api/runs/"
    external_type = "RUN_RECORD"
    operation = "fetch_run_records"

    def assets(self, *, query="", params=None, request=None):
        merged = {"q": query} if query else {}
        merged.update(params or {})
        return self.request(path="/api/assets/", params=merged, operation="fetch_data_assets", request=request)


class SmartAccessClient(BaseIntegrationClient):
    system = "SMARTACCESS"
    search_path = "/api/executions/"
    external_type = "RUN_RECORD"
    operation = "fetch_device_executions"

    def normalise_item(self, raw):
        item = super().normalise_item(raw)
        if item is None:
            return None
        # a device execution carries its trace identifier in the metadata
        trace = raw.get("run_trace") or raw.get("trace_id")
        if trace:
            item["metadata"]["run_trace"] = trace
        return item


class PolyAgentClient(BaseIntegrationClient):
    system = "POLY_AGENT"
    search_path = "/api/projects/"
    external_type = "RD_PROJECT"
    operation = "fetch_rd_projects"

    def tasks(self, *, query="", params=None, request=None):
        merged = {"q": query} if query else {}
        merged.update(params or {})
        return self.request(path="/api/tasks/", params=merged, operation="fetch_rd_tasks", request=request)


class SpecAgentClient(BaseIntegrationClient):
    system = "SPEC_AGENT"
    search_path = "/api/analyses/"
    external_type = "ANALYSIS_RESULT"
    operation = "fetch_analysis_results"

    def normalise_item(self, raw):
        item = super().normalise_item(raw)
        if item is None:
            return None
        # a result keeps its generation time and method for the chain view
        item["metadata"]["generated_at"] = raw.get("generated_at") or raw.get("created_at")
        item["metadata"]["method"] = raw.get("method") or raw.get("analysis_method")
        return item


ADAPTERS = {
    "RAGPORTAL": RagPortalClient,
    "WEKNORA": WeKnoraClient,
    "SPECLABOS": SpecLabOSClient,
    "SMARTACCESS": SmartAccessClient,
    "POLY_AGENT": PolyAgentClient,
    "SPEC_AGENT": SpecAgentClient,
}


def client_for(system, connection=None):
    """Return the adapter for a system (a null client when unknown)."""
    adapter = ADAPTERS.get(str(system or "").upper())
    if adapter is None:
        return BaseIntegrationClient(connection)
    return adapter(connection)
