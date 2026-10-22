"""Read-only payloads for historical administrative approvals."""

from django.db.models import Q
from plane.db.models import (
    AdministrativeApprovalRequest,
    AdministrativeOrganizationMember,
    FileAsset,
    User,
    WorkspaceMember,
)
from plane.utils.administrative_projects import (
    effective_project_member,
    visible_administrative_projects,
)


def project_role(user, project):
    if not WorkspaceMember.objects.filter(workspace=project.workspace, member=user, is_active=True).exists():
        return None
    member = effective_project_member(user, project.workspace.slug, project.id)
    return member.role if member else None


def can_manage_project(user, project):
    return project_role(user, project) == 20


def step_approvers(project, step):
    """Organization role is a candidate set, never an implicit project grant."""
    if not project.administrative_organization_id:
        return []
    members = AdministrativeOrganizationMember.objects.filter(
        organization=project.administrative_organization,
        is_active=True,
        organization__deleted_at__isnull=True,
        member__is_active=True,
    )
    if step.approver_kind == "USER":
        candidates = User.objects.filter(id=step.approver_id, is_active=True)
        if not project.administrative_organization.is_default:
            candidates = candidates.filter(id__in=members.values("member_id"))
    else:
        candidates = User.objects.filter(id__in=members.filter(role="ADMIN").values("member_id"))
        if project.administrative_organization.is_default:
            candidates = User.objects.filter(
                id__in=WorkspaceMember.objects.filter(workspace=project.workspace, role=20, is_active=True).values(
                    "member_id"
                ),
                is_active=True,
            )
    return [user for user in candidates if project_role(user, project) is not None]


def current_approvers(approval):
    if (
        approval.status != "PENDING"
        or approval.project.archived_at
        or not approval.project.administrative_organization_id
    ):
        return []
    if approval.project.administrative_organization_id != approval.flow.organization_id:
        return []
    step = approval.flow.steps.filter(order=approval.current_step_order).first()
    return step_approvers(approval.project, step) if step else []


def visible_requests(workspace, user):
    return AdministrativeApprovalRequest.objects.filter(
        workspace=workspace, project_id__in=visible_administrative_projects(user, workspace.slug).values("id")
    ).select_related("project__workspace", "project__administrative_organization", "issue", "flow", "requested_by")


def related_requests(approvals, workspace, user):
    """Personal inbox: requester, designated approvers, and past participants only.

    The caller first limits approvals to projects the user can still access.
    All steps count, including upcoming steps and steps on completed requests.
    """
    admin_organizations = AdministrativeOrganizationMember.objects.filter(
        workspace=workspace,
        member=user,
        is_active=True,
        role="ADMIN",
        organization__deleted_at__isnull=True,
    ).values("organization_id")
    organization_approver = Q(
        flow__steps__approver_kind="ORG_ADMIN",
        project__administrative_organization__is_default=False,
        project__administrative_organization_id__in=admin_organizations,
    )
    if WorkspaceMember.objects.filter(workspace=workspace, member=user, is_active=True, role=20).exists():
        organization_approver |= Q(
            flow__steps__approver_kind="ORG_ADMIN",
            project__administrative_organization__is_default=True,
        )
    return approvals.filter(
        Q(requested_by=user)
        | Q(actions__actor=user)
        | Q(flow__steps__approver_kind="USER", flow__steps__approver=user)
        | organization_approver
    ).distinct()


def request_payload(approval, user, history=False):
    approvers = current_approvers(approval)
    pending = approval.status == "PENDING"
    payload = {
        "id": str(approval.id),
        "project_id": str(approval.project_id),
        "project_name": approval.project.name,
        "issue_id": str(approval.issue_id),
        "title": approval.issue.name,
        "flow_id": str(approval.flow_id),
        "flow_name": approval.flow.name,
        "flow_version": approval.flow.version,
        "approval_mode": "FLOW" if approval.flow.is_template else "DIRECT",
        "status": approval.status,
        "step": approval.current_step_order,
        "requester": {"id": str(approval.requested_by_id), "display_name": approval.requested_by.display_name},
        "approvers": [{"id": str(actor.id), "display_name": actor.display_name} for actor in approvers],
        "can_act": False,
        "can_withdraw": False,
        "can_cancel": False,
        "blocked": pending and not approvers,
        "due_at": approval.issue.target_date,
        "created_at": approval.created_at,
        "updated_at": approval.updated_at,
    }
    if history:
        issue = approval.issue
        payload["work_item"] = {
            "id": str(issue.id),
            "workspace_id": str(approval.workspace_id),
            "identifier": f"{approval.project.identifier}-{issue.sequence_id}",
            "name": issue.name,
            "description_html": issue.description_html,
            "state": issue.state.name if issue.state_id else None,
            "priority": issue.priority,
            "start_date": issue.start_date,
            "target_date": issue.target_date,
            "assignees": [
                {"id": str(actor.id), "display_name": actor.display_name}
                for actor in issue.assignees.filter(issue_assignee__deleted_at__isnull=True)
            ],
            "attachments": [
                {
                    "id": str(asset.id),
                    "name": asset.attributes.get("name") or asset.asset.name.rsplit("/", 1)[-1],
                    "url": asset.asset_url,
                }
                for asset in FileAsset.objects.filter(
                    workspace_id=approval.workspace_id,
                    project_id=approval.project_id,
                    issue=issue,
                    entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
                    is_uploaded=True,
                    is_deleted=False,
                )
            ],
        }
        payload["steps"] = [
            {
                "order": step.order,
                "approver_kind": step.approver_kind,
                "approver_name": step.approver.display_name if step.approver_id else "组织管理员",
            }
            for step in approval.flow.steps.select_related("approver")
        ]
        payload["history"] = [
            {
                "id": str(action.id),
                "action": action.action,
                "comment": action.comment,
                "step": action.step_order,
                "actor": action.actor.display_name,
                "created_at": action.created_at,
            }
            for action in approval.actions.select_related("actor")
        ]
    return payload


