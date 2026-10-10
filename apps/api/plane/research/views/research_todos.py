# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Read-only unified research todo API."""

import base64
import json

from rest_framework import status
from rest_framework.response import Response

from plane.research.services.research_todos import TODO_SCOPES, collect_research_todos
from plane.research.utils.capabilities import NAV_OVERVIEW
from plane.research.utils.errors import ResearchErrorCode, research_error
from plane.research.views.base import ResearchAPIView

DEFAULT_TODO_LIMIT = 50
MAX_TODO_LIMIT = 100


def encode_todo_cursor(offset):
    """Encode a pagination offset as an opaque URL-safe cursor.

    Args:
        offset: Zero-based offset into the stable aggregate ordering.

    Returns:
        A base64url cursor without padding.
    """
    raw = json.dumps({"offset": offset}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def decode_todo_cursor(value):
    """Decode an opaque todo cursor.

    Args:
        value: Cursor supplied by the client.

    Returns:
        A ``(offset, error_response)`` pair with exactly one non-null side.
    """
    try:
        padded = value + "=" * (-len(value) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()))
        offset = payload["offset"]
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            raise ValueError("offset must be a non-negative integer")
        return offset, None
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None, research_error(
            ResearchErrorCode.CHAIN_INVALID,
            "cursor is invalid.",
            status.HTTP_400_BAD_REQUEST,
        )


class ResearchTodoListEndpoint(ResearchAPIView):
    """``GET /api/research/workspaces/<slug>/research-todos/``."""

    nav_capability = NAV_OVERVIEW

    def get(self, request, slug):
        """Return one read-only, ACL-filtered todo projection page."""
        workspace, error = self.get_workspace()
        if error:
            return error
        scope = str(request.GET.get("scope") or "to_me").lower()
        if scope not in TODO_SCOPES:
            return research_error(
                ResearchErrorCode.CHAIN_INVALID,
                "scope must be to_me, mine or visible.",
                status.HTTP_400_BAD_REQUEST,
            )
        try:
            limit = int(request.GET.get("limit") or DEFAULT_TODO_LIMIT)
        except (TypeError, ValueError):
            return research_error(
                ResearchErrorCode.CHAIN_INVALID,
                "limit must be a positive integer.",
                status.HTTP_400_BAD_REQUEST,
            )
        if limit < 1 or limit > MAX_TODO_LIMIT:
            return research_error(
                ResearchErrorCode.CHAIN_INVALID,
                f"limit must be between 1 and {MAX_TODO_LIMIT}.",
                status.HTTP_400_BAD_REQUEST,
            )
        offset = 0
        cursor = request.GET.get("cursor")
        if cursor:
            offset, error = decode_todo_cursor(cursor)
            if error:
                return error

        todos, degraded_sources = collect_research_todos(workspace, request.user, scope)
        page = todos[offset : offset + limit]
        next_cursor = encode_todo_cursor(offset + limit) if offset + limit < len(todos) else None
        return Response(
            {
                "schema_version": "research-todo.v2",
                "results": page,
                "count": len(page),
                "total_count": len(todos),
                "next_cursor": next_cursor,
                "degraded_sources": degraded_sources,
            }
        )
