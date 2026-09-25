"""Unit tests for the stable research action capability envelope."""

from plane.research.utils.action_capabilities import action_capability, capability_map


def test_allowed_action_has_stable_success_shape():
    """Allowed actions are explicit and do not rely on omitted fields."""
    assert action_capability("view", True) == {
        "allowed": True,
        "reason_code": "allowed",
        "reason": "允许操作",
    }


def test_denied_action_has_machine_and_human_reason():
    """Denied actions expose a stable reason code for UI and telemetry."""
    assert action_capability("review", False) == {
        "allowed": False,
        "reason_code": "approval_action_not_allowed",
        "reason": "当前身份无权执行此操作",
    }


def test_capability_map_defaults_unknown_actions_to_denied():
    """A missing decision fails closed while preserving the requested action."""
    payload = capability_map(("view", "agent_review"), {"view": True})
    assert payload["schema_version"] == "research-capabilities.v1"
    assert payload["actions"]["view"]["allowed"] is True
    assert payload["actions"]["agent_review"]["allowed"] is False
