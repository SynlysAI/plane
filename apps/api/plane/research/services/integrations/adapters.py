# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Per system adapters (P1-D2 ~ P1-D4).

Each adapter declares the paths it talks to and how a payload maps onto the
shared reference shape. Field口径 differences stay inside the adapter so the
generic layer never learns about a single vendor.
"""

from .base import BaseIntegrationClient


class RagPortalClient(BaseIntegrationClient):
    system = "RAGPORTAL"
    search_path = "/api/kb/list"
    upload_path = "/api/uploads"
    upload_detail_path = "/api/uploads/{upload_id}"
    visible_path = "/api/uploads/{external_id}"
    health_path = "/api/health"
    external_type = "KNOWLEDGE_ENTRY"
    operation = "fetch_knowledge_entries"

    def normalise(self, payload):
        """Normalise RAGPortal KB list and upload responses to references."""
        if isinstance(payload, dict) and "items" not in payload:
            payload = {"items": [payload]}
        return super().normalise(payload)

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
