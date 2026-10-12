"""Small, dependency-free client for Plane's version 1 public API.

The base URL is the origin (for example http://127.0.0.1:8001), without
/api/v1. HTTP errors deliberately never include response bodies or credentials.
"""

from __future__ import annotations

import json
import math
import os
import socket
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping
from urllib import error, parse, request


class PlaneError(RuntimeError):
    """A safe-to-display error, with no raw server or transport text."""

    def __init__(
        self, code: str, message: str, *, status: int | None = None,
        write_outcome_unknown: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.write_outcome_unknown = write_outcome_unknown


@dataclass(frozen=True, repr=False)
class PlaneConfig:
    base_url: str
    workspace_slug: str
    api_key: str
    timeout: float = 20.0

    def __post_init__(self) -> None:
        try:
            origin = parse.urlsplit(self.base_url)
            valid_origin = (
                origin.scheme in {"http", "https"} and bool(origin.hostname)
                and origin.username is None and origin.password is None
                and origin.path in {"", "/"} and not origin.query and not origin.fragment
                and origin.port != 0
            )
        except (ValueError, TypeError):
            valid_origin = False
        if not valid_origin or any(c.isspace() or ord(c) < 32 for c in self.base_url):
            raise PlaneError("configuration", "PLANE_BASE_URL must be an HTTP(S) origin without /api/v1 or credentials.")
        if not self.workspace_slug or any(c in self.workspace_slug for c in "/\\\r\n?#"):
            raise PlaneError("configuration", "PLANE_WORKSPACE_SLUG must be a nonempty workspace slug.")
        if not self.api_key or any(ord(c) < 33 or ord(c) > 126 for c in self.api_key):
            raise PlaneError("configuration", "PLANE_API_KEY is missing or invalid; set it locally.")
        if not math.isfinite(self.timeout) or self.timeout <= 0:
            raise PlaneError("configuration", "The request timeout must be a positive finite number.")
        object.__setattr__(self, "base_url", self.base_url.rstrip("/"))


def load_config(
    config_path: str | Path | None = None, *, environ: Mapping[str, str] | None = None,
    timeout: float = 20.0,
) -> PlaneConfig:
    """Read a private JSON object; nonempty environment variables override it."""
    values: dict[str, Any] = {}
    if config_path is not None:
        try:
            values = json.loads(Path(config_path).read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeError, ValueError):
            raise PlaneError("configuration", "Cannot read the private JSON configuration.") from None
        if not isinstance(values, dict):
            raise PlaneError("configuration", "The private configuration must be a JSON object.")
    source = os.environ if environ is None else environ
    names = ("PLANE_BASE_URL", "PLANE_WORKSPACE_SLUG", "PLANE_API_KEY")
    for name in names:
        if source.get(name):
            values[name] = source[name]
        if not isinstance(values.get(name), str):
            raise PlaneError("configuration", f"Set {name} in the environment or private configuration.")
    return PlaneConfig(*(values[name] for name in names), timeout=timeout)


Transport = Callable[[str, str, Mapping[str, str], bytes | None, float], tuple[int, bytes]]


class _NoRedirect(request.HTTPRedirectHandler):
    # Never forward the API key to another origin, including on a login redirect.
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


def _http_transport(
    method: str, url: str, headers: Mapping[str, str], body: bytes | None, timeout: float,
) -> tuple[int, bytes]:
    opener = request.build_opener(_NoRedirect())
    req = request.Request(url, data=body, headers=dict(headers), method=method)
    try:
        with opener.open(req, timeout=timeout) as response:
            return response.status, response.read()
    except error.HTTPError as exc:
        # Do not read/log an error body: it could echo a key or private data.
        status = exc.code
        exc.close()
        return status, b""


class PlaneClient:
    def __init__(self, config: PlaneConfig, *, transport: Transport | None = None) -> None:
        self.config = config
        self._transport = transport or _http_transport
        self.workspace_path = f"/api/v1/workspaces/{parse.quote(config.workspace_slug, safe='')}/"

    def request(
        self, method: str, path: str, *, data: dict[str, Any] | None = None,
        query: Mapping[str, Any] | None = None,
    ) -> Any:
        method = method.upper()
        if not path.startswith(self.workspace_path) or "?" in path or "#" in path:
            raise PlaneError("request_path", "The API path must stay inside the configured workspace.")
        url = self.config.base_url + path
        if query:
            url += "?" + parse.urlencode(query)
        headers = {"Accept": "application/json", "X-Api-Key": self.config.api_key}
        body = None
        if data is not None:
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        is_write = method not in {"GET", "HEAD", "OPTIONS"}
        try:
            status, raw = self._transport(method, url, headers, body, self.config.timeout)
        except (TimeoutError, socket.timeout):
            raise PlaneError(
                "timeout", "Plane request timed out. Read the resource before considering another write.",
                write_outcome_unknown=is_write,
            ) from None
        except (OSError, error.URLError, ValueError):
            raise PlaneError(
                "transport", "Cannot reach the Plane API. Check the service address and network locally.",
                write_outcome_unknown=is_write,
            ) from None
        if not 200 <= status < 300:
            raise PlaneError(
                "http_error", f"Plane API returned HTTP {status}; response details are withheld.",
                status=status, write_outcome_unknown=is_write and (status >= 500 or status in {408, 409}),
            )
        try:
            return json.loads(raw)
        except (ValueError, UnicodeError):
            raise PlaneError(
                "invalid_response", "Plane returned invalid JSON; response details are withheld.",
                write_outcome_unknown=is_write,
            ) from None

    def list_all(
        self, path: str, *, query: Mapping[str, Any] | None = None, max_pages: int = 1000,
    ) -> list[dict[str, Any]]:
        """Consume Plane's cursor pages. Ambiguous/repeating pages fail closed."""
        params: dict[str, Any] = {"per_page": 100, **(query or {})}
        seen_cursors: set[str] = set()
        seen_ids: set[str] = set()
        output: list[dict[str, Any]] = []
        for _ in range(max_pages):
            page = self.request("GET", path, query=params)
            # Older deployments return an unpaginated array for some lists.
            if isinstance(page, list):
                if output:
                    raise PlaneError("pagination", "Plane changed pagination format during a list request.")
                rows, has_next = page, False
            elif isinstance(page, dict) and isinstance(page.get("results"), list):
                rows = page["results"]
                has_next = page.get("next_page_results")
                if not isinstance(has_next, bool):
                    raise PlaneError("pagination", "Plane pagination metadata is missing or invalid.")
            else:
                raise PlaneError("pagination", "Plane list response has an unexpected shape.")
            for row in rows:
                if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]:
                    raise PlaneError("pagination", "Plane list contains an invalid resource.")
                if row["id"] in seen_ids:
                    raise PlaneError("pagination", "Plane repeated a resource across pages; retry the read later.")
                seen_ids.add(row["id"])
                output.append(row)
            if not has_next:
                return output
            cursor = page.get("next_cursor")
            if not isinstance(cursor, str) or not cursor or cursor in seen_cursors or cursor == params.get("cursor"):
                raise PlaneError("pagination", "Plane returned a missing or repeated next cursor.")
            seen_cursors.add(cursor)
            params["cursor"] = cursor
        raise PlaneError("pagination", "Plane pagination exceeded the safety limit; the list is incomplete.")

    def project_path(self, project_id: str) -> str:
        return self.workspace_path + "projects/" + parse.quote(project_id, safe="") + "/"

    def list_projects(self, *, lite: bool = False) -> list[dict[str, Any]]:
        endpoint = "projects-lite/" if lite else "projects/"
        return self.list_all(self.workspace_path + endpoint)

    def get_project(self, project_id: str) -> dict[str, Any]:
        return self.request("GET", self.project_path(project_id))

    def create_project(self, data: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", self.workspace_path + "projects/", data=data)

    def list_states(self, project_id: str) -> list[dict[str, Any]]:
        return self.list_all(self.project_path(project_id) + "states/")

    def list_work_items(self, project_id: str) -> list[dict[str, Any]]:
        return self.list_all(self.project_path(project_id) + "work-items/")

    def create_work_item(self, project_id: str, data: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", self.project_path(project_id) + "work-items/", data=data)

    def get_work_item(self, project_id: str, work_item_id: str) -> dict[str, Any]:
        return self.request("GET", self.project_path(project_id) + "work-items/" + parse.quote(work_item_id, safe="") + "/")

    def list_comments(self, project_id: str, work_item_id: str) -> list[dict[str, Any]]:
        return self.list_all(self.project_path(project_id) + "work-items/" + parse.quote(work_item_id, safe="") + "/comments/")
