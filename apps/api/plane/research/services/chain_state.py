"""Phase 1 Research Chain node state machine and event taxonomy."""

import re

NODE_EVENT_TYPES = frozenset(
    {
        "NODE_CREATED",
        "NODE_STARTED",
        "AI_ACTION",
        "TOOL_CALL",
        "ARTIFACT_CREATED",
        "INTERMEDIATE_ARTIFACT",
        "VALIDATION",
        "VALIDATION_PASSED",
        "VALIDATION_FAILED",
        "HUMAN_DECISION",
        "OUTPUT",
        "NODE_COMPLETED",
        "NODE_FAILED",
        "NODE_RETRIED",
        "NODE_ARCHIVED",
    }
)

PHASE_ZERO_EVENT_TYPES = frozenset(
    {
        "RESEARCH_NOTE",
        "COMMUNICATION",
        "APPROVAL",
        "DATA_CHANGE",
        "DEGRADED",
    }
)

CHAIN_EVENT_TYPES = NODE_EVENT_TYPES | PHASE_ZERO_EVENT_TYPES

NODE_TYPE_PATTERN = re.compile(r"^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$")

TRANSITIONS = {
    "START": {
        "DRAFT": ("ACTIVE", "NODE_STARTED"),
        "NEEDS_REVISION": ("ACTIVE", "NODE_STARTED"),
        "FAILED": ("ACTIVE", "NODE_RETRIED"),
    },
    "SUBMIT_REVIEW": {"ACTIVE": ("WAITING_HUMAN", "HUMAN_DECISION")},
    "APPROVE": {"WAITING_HUMAN": ("COMPLETED", "NODE_COMPLETED")},
    "RETURN": {"WAITING_HUMAN": ("NEEDS_REVISION", "HUMAN_DECISION")},
    "FAIL": {"ACTIVE": ("FAILED", "NODE_FAILED")},
    "ARCHIVE": {
        "DRAFT": ("ARCHIVED", "NODE_ARCHIVED"),
        "ACTIVE": ("ARCHIVED", "NODE_ARCHIVED"),
        "WAITING_HUMAN": ("ARCHIVED", "NODE_ARCHIVED"),
        "NEEDS_REVISION": ("ARCHIVED", "NODE_ARCHIVED"),
        "FAILED": ("ARCHIVED", "NODE_ARCHIVED"),
        "COMPLETED": ("ARCHIVED", "NODE_ARCHIVED"),
    },
}

ACTION_ALIASES = {"RETRY": "START", "REACTIVATE": "START"}


def normalize_action(action):
    """Normalize client actions and their compatibility aliases."""
    normalized = str(action or "").strip().upper()
    return ACTION_ALIASES.get(normalized, normalized)


def resolve_transition(status, action):
    """Resolve a node transition without mutating the node.

    Args:
        status: The node's current status.
        action: The client-requested lifecycle action.

    Returns:
        A ``(new_status, event_type)`` tuple, or ``None`` when invalid.
    """
    normalized = normalize_action(action)
    return TRANSITIONS.get(normalized, {}).get(status)
