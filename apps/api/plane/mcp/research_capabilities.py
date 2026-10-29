"""Capability projections from the native roles/state, intersected with MCP policy."""

from types import SimpleNamespace

from plane.research.serializers import ResearchChainNodeTaskSerializer
from plane.research.services.agent_operations import allowed_actions, workspace_policy
from plane.research.services.chain_tasks import assignable_project_members
from plane.research.services.mcp_catalog import ResearchReadError


def policy_allows(connection, workspace):
    entry = next((item for item in connection.scope["workspaces"] if item["workspace_id"] == str(workspace.pk)), {})
    if entry.get("domains", {}).get("research") != "read_write" or not connection.scope["include_future_objects"]:
        return False
    try:
        workspace_policy(workspace)
        return True
    except ResearchReadError:
        return False


def actions_for(connection, workspace, kind, target):
    if kind not in {"ResearchChainNode", "ResearchChainNodeTask"} or not policy_allows(connection, workspace):
        return []
    node = target if kind == "ResearchChainNode" else target.node
    if node.chain.status != "ACTIVE" or node.status == "ARCHIVED":
        return []
    proposals = set()
    if node.status not in {"COMPLETED", "WAITING_HUMAN"}:
        proposals = set(allowed_actions(workspace, connection.owner, node))
        if kind == "ResearchChainNodeTask" and (
            target.status not in {"DRAFT", "ASSIGNED"}
            or target.resource_type != "NONE"
            or target.resource_id is not None
        ):
            proposals.discard("attach_task_resource")
    direct = []
    if kind == "ResearchChainNodeTask":
        # Only a serializer projection context; authorization uses the persisted connection owner.
        serializer = ResearchChainNodeTaskSerializer(context={"request": SimpleNamespace(user=connection.owner)})
        decisions = serializer.get_capabilities(target)["actions"]
        if decisions["edit"]["allowed"]:
            direct.append("update_task")
        direct.extend(action for action in ("complete", "reopen", "cancel") if decisions[action]["allowed"])
    return sorted(proposals) + direct


def capabilities(reader, workspace, kind, target):
    from plane.mcp.catalog import RESEARCH_FIELDS, RESEARCH_PAYLOADS

    actions = actions_for(reader.connection, workspace, kind, target)
    node = target if kind == "ResearchChainNode" else target.node
    members = assignable_project_members(workspace, node.chain).select_related("member")
    if "update_task" not in actions:
        members = members.none()
    if "query" in reader.args:
        members = members.filter(member__display_name__icontains=reader.args["query"])
    options = reader.page(
        [
            (
                "assignee",
                members,
                lambda row: {
                    "id": str(row.member_id),
                    "display_name": row.member.display_name or row.member.username or str(row.member_id),
                },
            )
        ]
    )
    transitions = [action for action in ("complete", "reopen", "cancel") if action in actions]
    proposal_actions = [action for action in RESEARCH_PAYLOADS if action in actions]
    return {
        "data": {
            "allowed_actions": actions,
            "editable_fields": list(RESEARCH_FIELDS) if "update_task" in actions else [],
            "assignable_users": options["data"],
            "transition_options": [
                {
                    "action": action,
                    "required_fields": ["target", "action", "request_id"]
                    + (["reason"] if action in {"reopen", "cancel"} else []),
                }
                for action in transitions
            ],
            "proposal_actions": [
                {
                    "action": action,
                    "tool": "plane_prepare_research_operation",
                    "payload_schema": RESEARCH_PAYLOADS[action],
                    "execution_mode": "proposal",
                }
                for action in proposal_actions
            ],
            "execution_modes": {action: "proposal" if action in RESEARCH_PAYLOADS else "direct" for action in actions},
            "execution_mode": "mixed" if actions else "read_only",
        },
        "page": options["page"],
    }
