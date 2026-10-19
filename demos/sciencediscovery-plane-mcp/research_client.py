"""Bounded, no-redirect reads from the configured research machine API."""

from __future__ import annotations

from urllib.parse import quote

import httpx

from plane_client import PlaneConfig, PlaneError


class ResearchClient:
    def __init__(self, config: PlaneConfig, *, operations=False, context_token=None, context_hash=None):
        self.config = config
        self.operations = operations
        if operations and not (context_token and context_hash):
            raise PlaneError("configuration", "Research operations require a separate context token and hash.")
        self.headers = ({"X-Research-Context-Token": context_token, "X-Research-Context-Hash": context_hash}
                        if operations else {"X-Api-Key": config.api_key})
        namespace = "agent-operations" if operations else "agent-access"
        self.root = f"{config.base_url}/api/research/workspaces/{quote(config.workspace_slug, safe='')}/{namespace}/"

    async def request(self, method: str, suffix: str, payload=None):
        # Callers supply only locally constructed suffixes, never a model-provided URL.
        try:
            async with httpx.AsyncClient(timeout=self.config.timeout, follow_redirects=False) as client:
                async with client.stream(method, self.root + suffix,
                    headers={**self.headers, "Accept": "application/json"}, json=payload) as response:
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > 262144:
                            raise PlaneError("response_too_large", "Research response exceeds the transport budget.")
            import json

            value = json.loads(body)
            if not 200 <= response.status_code < 300:
                import re
                code = value.get("error_code", "research_http_error") if isinstance(value, dict) else "research_http_error"
                if not isinstance(code, str) or not re.fullmatch(r"[a-z_]{1,80}", code):
                    code = "research_http_error"
                raise PlaneError(code, f"Research request rejected: {code} (HTTP {response.status_code}).", status=response.status_code)
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except PlaneError:
            raise
        except (httpx.HTTPError, ValueError, UnicodeError):
            raise PlaneError("research_unavailable", "Research request failed. For operations, query the same operation_id or repeat prepare with the same request_id; never blindly create a new request.",
                             write_outcome_unknown=self.operations and method == "POST") from None

    async def tools(self):
        return (await self.request("GET", "tools/"))["tools"]

    async def call_tool(self, name, arguments):
        return await self.request("POST", "tools/" + quote(name, safe="") + "/", arguments)
