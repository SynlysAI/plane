"""Bounded Plane metadata shared by every Synlora session transport."""

from __future__ import annotations

from plane.db.models import ResearchContextGrant


def target_title(grant: ResearchContextGrant) -> str:
    """Build a bounded Synlora session title from the authorized target."""
    if grant.chain_node is not None:
        return grant.chain_node.title[:120]
    if grant.research_chain is not None:
        if grant.project is not None:
            return grant.project.name[:120]
        return str(grant.research_chain_id)[:120]
    if grant.project is not None:
        return grant.project.name[:120]
    return f"Plane · {grant.workspace.name}"[:120]


def build_plane_metadata(grant: ResearchContextGrant, page_context: dict | None = None) -> dict:
    """Build token-free workspace/page metadata for a Synlora session."""
    target_id = (
        str(grant.chain_node_id or "")
        or str(grant.research_chain_id or "")
        or str(grant.project_id or "")
        or str(grant.workspace_id)
    )
    hierarchy = [{"type": "WORKSPACE", "id": str(grant.workspace_id), "title": grant.workspace.name}]
    if grant.project is not None:
        hierarchy.append({"type": "PROJECT", "id": str(grant.project_id), "title": grant.project.name})
    if grant.research_chain is not None:
        chain_title = grant.project.name if grant.project is not None else str(grant.research_chain_id)
        hierarchy.append(
            {
                "type": "RESEARCH_CHAIN",
                "id": str(grant.research_chain_id),
                "title": chain_title,
            }
        )
    if grant.chain_node is not None:
        hierarchy.append(
            {
                "type": "RESEARCH_CHAIN_NODE",
                "id": str(grant.chain_node_id),
                "title": grant.chain_node.title[:300],
            }
        )

    page_context = page_context or (grant.context_manifest or {}).get("page_context") or {}
    focus = page_context.get("focus") if isinstance(page_context.get("focus"), dict) else {}
    return {
        "workspace": {
            "id": str(grant.workspace_id),
            "slug": grant.workspace.slug,
            "name": grant.workspace.name,
        },
        "target": {
            "type": grant.target_type,
            "id": target_id,
            "title": target_title(grant),
            "hierarchy": hierarchy,
        },
        "page": {
            "route": str(page_context.get("route") or "")[:500],
            "page_kind": str(page_context.get("page_kind") or ""),
            "focus_id": str(focus.get("id") or target_id),
            "focus_title": str(focus.get("title") or target_title(grant)),
            "hash": str(page_context.get("hash") or "")[:128],
            "generated_at": str(page_context.get("generated_at") or "")[:64],
        },
    }
