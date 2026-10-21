"""Administrative approval transitions; every operation rechecks live access."""

from django.db import transaction
from django.db.models import Q
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework.exceptions import PermissionDenied, ValidationError, APIException
from plane.db.models import (
    AdministrativeApprovalAction,
    AdministrativeApprovalFlow,
    AdministrativeApprovalRequest,
    AdministrativeApprovalStep,
    AdministrativeOrganizationMember,
    AdministrativeProjectApprovalSetting,
    FileAsset,
    Issue,
    Project,
    User,
    WorkspaceMember,
)
from plane.utils.administrative_projects import (
    administrative_project_filter,
    effective_project_member,
    visible_administrative_projects,
    user_can_manage_administrative_organization,
)


class ApprovalConflict(APIException):
    status_code = 409
    default_detail = "审批状态已变化，请刷新后重试。"


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


def approver_options(project):
    """Offer only active members who can approve inside this project's organization."""
    if not project.administrative_organization_id or project.archived_at:
        return []
    candidates = User.objects.filter(
        member_workspace__workspace=project.workspace,
        member_workspace__is_active=True,
        member_workspace__deleted_at__isnull=True,
        is_active=True,
    )
    if not project.administrative_organization.is_default:
        candidates = candidates.filter(
            id__in=AdministrativeOrganizationMember.objects.filter(
                organization=project.administrative_organization, is_active=True
            ).values("member_id")
        )
    return [
        actor
        for actor in candidates.distinct().order_by("display_name", "id")
        if project_role(actor, project) is not None
    ]


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


def flow_payload(flow):
    return {
        "id": str(flow.id),
        "organization_id": str(flow.organization_id),
        "name": flow.name,
        "version": flow.version,
        "is_active": flow.is_active,
        "steps": [
            {
                "order": step.order,
                "approver_kind": step.approver_kind,
                "approver_id": str(step.approver_id) if step.approver_id else None,
            }
            for step in flow.steps.all()
        ],
    }


@transaction.atomic
def save_flow(workspace, user, organization, data, original=None):
    if not user_can_manage_administrative_organization(user, workspace.slug, organization.id):
        raise PermissionDenied("只有行政组织管理员可以维护审批流程。")
    if original:
        if not original.is_template:
            raise ValidationError("单次审批不能保存为固定流程版本。")
        original = AdministrativeApprovalFlow.objects.select_for_update().get(pk=original.pk)
        if not original.is_active:
            raise ApprovalConflict("该流程已有新版本，请刷新后编辑。")
    name = str(data.get("name", "")).strip()
    steps = data.get("steps")
    if not name or len(name) > 255 or not isinstance(steps, list) or not 1 <= len(steps) <= 20:
        raise ValidationError("请填写流程名称，并配置 1–20 个审批步骤。")
    resolved = []
    for item in steps:
        if not isinstance(item, dict) or item.get("approver_kind") not in ("USER", "ORG_ADMIN"):
            raise ValidationError("审批人类型无效。")
        actor = None
        if item["approver_kind"] == "USER":
            actor = User.objects.filter(pk=item.get("approver_id"), is_active=True).first()
            if (
                actor is None
                or not WorkspaceMember.objects.filter(workspace=workspace, member=actor, is_active=True).exists()
            ):
                raise ValidationError("指定审批人不是有效工作区成员。")
            if (
                not organization.is_default
                and not AdministrativeOrganizationMember.objects.filter(
                    organization=organization, member=actor, is_active=True
                ).exists()
            ):
                raise ValidationError("指定审批人必须属于当前行政组织。")
        resolved.append((item["approver_kind"], actor))
    # Immutable versions also keep already selected project templates explicit.
    values = {"family_id": original.family_id, "version": original.version + 1} if original else {}
    flow = AdministrativeApprovalFlow.objects.create(
        workspace=workspace, organization=organization, name=name, created_by=user, **values
    )
    for order, (kind, actor) in enumerate(resolved, 1):
        AdministrativeApprovalStep.objects.create(flow=flow, order=order, approver_kind=kind, approver=actor)
    if original:
        original.is_active = False
        original.save(update_fields=["is_active", "updated_at"])
    return flow


@transaction.atomic
def submit_request(workspace, user, project, issue_id, *, flow_id=None, approver_id=None):
    project = (
        Project.objects.select_for_update(of=("self",))
        .select_related("workspace", "administrative_organization")
        .get(pk=project.pk)
    )
    if not Project.objects.filter(pk=project.pk).filter(administrative_project_filter()).exists():
        raise ValidationError("科研项目不能发起行政审批。")
    if (project_role(user, project) or 0) < 15 or project.archived_at:
        raise PermissionDenied("没有发起该项目审批的权限。")
    issue = (
        Issue.objects.select_for_update()
        .filter(pk=issue_id, project=project, workspace=workspace, archived_at__isnull=True)
        .first()
    )
    if issue is None:
        raise ValidationError("请选择当前行政项目内未归档的任务。")
    if flow_id and approver_id:
        raise ValidationError("请选择指定审批人或固定流程中的一种方式。")
    if approver_id:
        actor = next((actor for actor in approver_options(project) if str(actor.id) == str(approver_id)), None)
        if actor is None:
            raise ValidationError("请选择当前行政组织内有项目访问权限的有效审批人。")
        flow = AdministrativeApprovalFlow.objects.create(
            workspace=workspace,
            organization=project.administrative_organization,
            name="指定审批人",
            is_template=False,
            is_active=False,
            created_by=user,
        )
        AdministrativeApprovalStep.objects.create(flow=flow, order=1, approver_kind="USER", approver=actor)
    elif flow_id:
        try:
            flow = AdministrativeApprovalFlow.objects.filter(
                pk=flow_id,
                workspace=workspace,
                organization_id=project.administrative_organization_id,
                is_template=True,
                is_active=True,
            ).first()
        except (DjangoValidationError, ValueError, TypeError):
            flow = None
        if flow is None:
            raise ValidationError("请选择当前行政组织的有效审批流程。")
    else:
        # Keep previously configured API clients working; new clients choose per request.
        setting = AdministrativeProjectApprovalSetting.objects.filter(project=project).select_related("flow").first()
        if not setting or setting.flow.organization_id != project.administrative_organization_id:
            raise ValidationError("请选择审批人或审批流程。")
        flow = setting.flow
    steps = list(flow.steps.all())
    if not steps or any(not step_approvers(project, step) for step in steps):
        raise ValidationError("审批流程存在无有效审批人的步骤，请管理员调整成员或流程。")
    if AdministrativeApprovalRequest.objects.filter(issue=issue, status="PENDING").exists():
        raise ApprovalConflict("该任务已有进行中的审批。")
    approval = AdministrativeApprovalRequest.objects.create(
        workspace=workspace, project=project, issue=issue, flow=flow, requested_by=user
    )
    AdministrativeApprovalAction.objects.create(request=approval, actor=user, step_order=1, action="SUBMIT")
    return approval


@transaction.atomic
def act_on_request(approval, user, action, expected_step, comment=""):
    approval = (
        AdministrativeApprovalRequest.objects.select_for_update(of=("self",))
        .select_related("project__workspace", "project__administrative_organization", "flow", "issue", "requested_by")
        .get(pk=approval.pk)
    )
    if project_role(user, approval.project) is None:
        raise PermissionDenied("项目访问权限已失效。")
    if approval.status != "PENDING" or expected_step != approval.current_step_order:
        raise ApprovalConflict()
    comment = str(comment or "").strip()
    if action in ("APPROVE", "REJECT"):
        if user.id not in {actor.id for actor in current_approvers(approval)}:
            raise PermissionDenied("当前步骤不由你审批，或项目／组织权限已变化。")
        if action == "REJECT":
            if not comment:
                raise ValidationError("请填写驳回原因。")
            approval.status = "REJECTED"
        else:
            next_step = approval.flow.steps.filter(order__gt=approval.current_step_order).first()
            if next_step and not step_approvers(approval.project, next_step):
                raise ApprovalConflict("下一步没有有效审批人，请管理员处理后重试。")
            if next_step:
                approval.current_step_order = next_step.order
            else:
                approval.status = "APPROVED"
    elif action == "WITHDRAW" and approval.requested_by_id == user.id:
        approval.status = "WITHDRAWN"
    elif action == "CANCEL" and can_manage_project(user, approval.project):
        if not comment:
            raise ValidationError("请填写取消原因。")
        approval.status = "CANCELLED"
    else:
        raise PermissionDenied("没有执行此操作的权限。")
    AdministrativeApprovalAction.objects.create(
        request=approval, actor=user, step_order=expected_step, action=action, comment=comment
    )
    approval.save(update_fields=["status", "current_step_order", "updated_at"])
    return approval
