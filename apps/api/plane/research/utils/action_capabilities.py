"""Stable action capability projections for research resources.

The API returns an explicit decision for every action that a client may render.
This keeps the UI from inferring write permission from a successful detail
request and gives denied actions a machine-readable reason.
"""

from collections.abc import Iterable, Mapping


CAPABILITY_SCHEMA_VERSION = "research-capabilities.v1"

ACTION_REASON_CODES = {
    "view": "research_permission_denied",
    "download": "research_permission_denied",
    "export": "research_permission_denied",
    "edit": "research_owner_only",
    "submit": "research_owner_only",
    "delete": "research_owner_only",
    "review": "approval_action_not_allowed",
    "accept": "approval_action_not_allowed",
    "return": "approval_action_not_allowed",
    "manage_access": "research_owner_only",
    "transition": "node_action_not_allowed",
    "upload": "research_upload_not_allowed",
    "agent_review": "agent_scope_not_allowed",
    "archive": "research_manager_only",
    "restore": "research_manager_only",
}


def action_capability(
    action: str,
    allowed: bool,
    *,
    reason_code: str | None = None,
    reason: str | None = None,
) -> dict[str, object]:
    """Build one stable capability decision.

    Args:
        action: Canonical action name.
        allowed: Whether the current actor may execute the action.
        reason_code: Optional override for a denied action.
        reason: Optional human-readable explanation.

    Returns:
        A JSON-serialisable capability decision.
    """
    if allowed:
        return {"allowed": True, "reason_code": "allowed", "reason": "允许操作"}
    return {
        "allowed": False,
        "reason_code": reason_code or ACTION_REASON_CODES.get(action, "research_action_not_allowed"),
        "reason": reason or "当前身份无权执行此操作",
    }


def capability_map(
    actions: Iterable[str], decisions: Mapping[str, bool], *, reasons: Mapping[str, Mapping[str, str]] | None = None
) -> dict[str, object]:
    """Build a versioned capability map from boolean decisions."""
    reasons = reasons or {}
    return {
        "schema_version": CAPABILITY_SCHEMA_VERSION,
        "actions": {
            action: action_capability(
                action,
                bool(decisions.get(action, False)),
                reason_code=reasons.get(action, {}).get("reason_code"),
                reason=reasons.get(action, {}).get("reason"),
            )
            for action in actions
        },
    }
