"""开发环境账号与组织收敛：只保留最小测试身份。"""

from __future__ import annotations

import os
from typing import Iterable

from django.conf import settings
from django.db import connection, models, transaction
from django.db.models.deletion import ProtectedError
from django.utils import timezone

from plane.db.models import (
    AccountLink,
    AdministrativeOrganization,
    Issue,
    MentorBinding,
    OrgUnit,
    OrgUnitMember,
    Project,
    ProjectNavigationCategory,
    ResearchChain,
    ResearchGroupKnowledgeBinding,
    ResearchUserProfile,
    ResearchWorkspaceAccessGrant,
    User,
    Workspace,
    WorkspaceMember,
    WorkspaceResearchSetting,
)
from plane.db.models.session import Session
from plane.license.models import InstanceAdmin, InstanceRoleAssignment
from plane.db.models.research.append_only import AppendOnlyModel
from plane.research.services.dev_environment import reset_workspace_business_data
from plane.research.utils.org import build_path, move_subtree
from plane.research.utils.roles import (
    MAIN_PI,
    PI_WORKSPACE_SLUG,
    PUBLIC_WORKSPACE_SLUG,
    WORKSPACE_ADMIN_ROLE,
    WORKSPACE_MEMBER_ROLE,
)

ADMIN_EMAIL = "admin@ai4ms.local"
MAIN_PI_EMAIL = "whong@xmu.edu.cn"
ADVISOR_EMAIL = "jyliu@xmu.edu.cn"
STUDENT_EMAIL = "17720599271@163.com"
MEMBER_EMAIL = "gaopeng.member@ai4ms.local"

KEEP_HUMAN_EMAILS = frozenset(
    {
        MAIN_PI_EMAIL,
        ADMIN_EMAIL,
        ADVISOR_EMAIL,
        STUDENT_EMAIL,
        MEMBER_EMAIL,
    }
)
KEEP_DISPLAY_NAMES = {
    MAIN_PI_EMAIL: "洪文晶",
    ADVISOR_EMAIL: "刘俊扬",
    STUDENT_EMAIL: "张曦宇",
    MEMBER_EMAIL: "高鹏",
}
ROOT_ORG_NAME = "π-Lab"
BASIC_RESEARCH_NAME = "基础研究"
DEVICE_TEAM_NAME = "器件"
ORG_KEEP_NAMES = (ROOT_ORG_NAME, BASIC_RESEARCH_NAME, DEVICE_TEAM_NAME)
PRODUCTION_WEB_URL_MARKERS = ("10.26.15.", "openeva.xmuzc.com")
TARGET_WORKSPACE_SLUGS = (PUBLIC_WORKSPACE_SLUG, PI_WORKSPACE_SLUG)
DEV_PRUNE_FLAG = "PLANE_DEV_PRUNE"


class DevAccountPruneError(Exception):
    """开发环境账号清理因安全检查或数据前置条件失败。"""


def is_production_web_url(web_url: str | None = None) -> bool:
    """判断 WEB_URL 是否指向生产实例。

    Args:
        web_url: 待检查地址，缺省读取 Django settings.WEB_URL。

    Returns:
        命中生产标记时为 True。
    """
    value = (web_url if web_url is not None else getattr(settings, "WEB_URL", "") or "").lower()
    return any(marker in value for marker in PRODUCTION_WEB_URL_MARKERS)


def assert_dev_prune_allowed() -> None:
    """拒绝在缺少开关或生产地址上执行写入清理。"""
    if os.environ.get(DEV_PRUNE_FLAG) != "1":
        raise DevAccountPruneError(f"拒绝执行：需要环境变量 {DEV_PRUNE_FLAG}=1")
    web_url = getattr(settings, "WEB_URL", "") or ""
    if is_production_web_url(web_url):
        raise DevAccountPruneError(f"拒绝执行：WEB_URL 指向生产环境（{web_url}）")


def preview_dev_account_prune() -> dict:
    """生成只读清理预告，不修改数据库。

    Returns:
        将删除的项目、账号、组织节点及缺失保留账号。
    """
    workspaces = _target_workspaces()
    missing_workspaces = sorted(set(TARGET_WORKSPACE_SLUGS) - {workspace.slug for workspace in workspaces})
    keep_users = _keep_users()
    extra_users = _extra_human_users()
    keep_org_ids = _planned_keep_org_ids(_workspace_by_slug(workspaces, PUBLIC_WORKSPACE_SLUG))
    extra_org_query = OrgUnit.all_objects.exclude(id__in=keep_org_ids) if keep_org_ids else OrgUnit.all_objects.all()
    extra_org_units = list(extra_org_query)
    return {
        "mode": "dry-run",
        "workspaces": [workspace.slug for workspace in workspaces],
        "missing_workspaces": missing_workspaces,
        "missing_keep_users": _missing_keep_emails(keep_users),
        "projects_to_delete": Project.all_objects.filter(workspace__in=workspaces).count(),
        "accounts_to_delete": extra_users.count(),
        "org_units_to_delete": len(extra_org_units),
        "keep_users": sorted(KEEP_HUMAN_EMAILS),
        "bots": User.objects.filter(is_bot=True).count(),
        "account_emails_to_delete": list(extra_users.order_by("email").values_list("email", flat=True)),
        "org_units_to_delete_names": [unit.name for unit in extra_org_units],
    }


def prune_dev_accounts() -> dict:
    """在事务内清理业务数据、多余账号，并重建最小组织与身份。

    Returns:
        写入结果与清理后的关键计数。
    """
    assert_dev_prune_allowed()
    workspaces = _target_workspaces()
    missing_workspaces = sorted(set(TARGET_WORKSPACE_SLUGS) - {workspace.slug for workspace in workspaces})
    if missing_workspaces:
        raise DevAccountPruneError(f"工作区不存在：{', '.join(missing_workspaces)}")
    keep_users = _keep_users()
    missing = _missing_keep_emails(keep_users)
    if missing:
        raise DevAccountPruneError(f"缺少必须保留的账号：{', '.join(missing)}")
    extra_users = list(_extra_human_users())
    public = _workspace_by_slug(workspaces, PUBLIC_WORKSPACE_SLUG)
    pi = _workspace_by_slug(workspaces, PI_WORKSPACE_SLUG)
    admin = keep_users[ADMIN_EMAIL]
    with transaction.atomic():
        deleted_business = reset_workspace_business_data(workspaces)
        org_units = converge_org_tree(public)
        _delete_extra_org_units(keep_ids={unit.id for unit in org_units.values()})
        _restore_default_administrative_organizations(workspaces, admin)
        deleted_accounts = delete_extra_accounts(extra_users, admin=admin)
        repair_identities(users=keep_users, public=public, pi=pi, org_units=org_units)
    return {
        "mode": "apply",
        "deleted": deleted_business,
        "deleted_accounts": deleted_accounts,
        "after": _after_snapshot(),
    }


def converge_org_tree(workspace: Workspace) -> dict[str, OrgUnit]:
    """把 public 组织收敛为 π-Lab → 基础研究 → 器件。

    Args:
        workspace: public 工作区。

    Returns:
        以节点名为键的三个保留组织单元。
    """
    root = _ensure_named_unit(
        workspace,
        ROOT_ORG_NAME,
        parent=None,
        unit_type=OrgUnit.UnitType.ROOT,
        business_category=None,
        depth=0,
        sort_order=1,
    )
    basic = _ensure_named_unit(
        workspace,
        BASIC_RESEARCH_NAME,
        parent=root,
        unit_type=OrgUnit.UnitType.LAB,
        business_category=OrgUnit.BusinessCategory.BASIC_RESEARCH,
        depth=1,
        sort_order=1,
    )
    device = _ensure_named_unit(
        workspace,
        DEVICE_TEAM_NAME,
        parent=basic,
        unit_type=OrgUnit.UnitType.TEAM,
        business_category=OrgUnit.BusinessCategory.BASIC_RESEARCH,
        depth=2,
        sort_order=1,
    )
    return {ROOT_ORG_NAME: root, BASIC_RESEARCH_NAME: basic, DEVICE_TEAM_NAME: device}


def delete_extra_accounts(users: Iterable[User], *, admin: User) -> int:
    """硬删除不在保留名单中的人类账号，并解除会阻止删除的保护关系。

    Args:
        users: 待删除的人类账号。
        admin: 工作区所有权与残留 PROTECT 外键的接管账号。

    Returns:
        实际删除的账号数。
    """
    extra_users = list(users)
    if not extra_users:
        return 0
    extra_ids = [user.id for user in extra_users]
    _reassign_workspace_owners(extra_ids, admin)
    _clear_user_protect_relations(extra_ids, admin)
    Session.objects.filter(user_id__in=[str(user_id) for user_id in extra_ids]).delete()
    _hard_delete_queryset(InstanceAdmin.all_objects.filter(user_id__in=extra_ids))
    _hard_delete_queryset(InstanceRoleAssignment.all_objects.filter(user_id__in=extra_ids))
    deleted = 0
    for user in extra_users:
        user.delete()
        deleted += 1
    return deleted


def repair_identities(
    *,
    users: dict[str, User],
    public: Workspace,
    pi: Workspace,
    org_units: dict[str, OrgUnit],
) -> None:
    """幂等修复保留账号的工作区席位、组织角色和导师绑定。

    Args:
        users: 以小写邮箱为键的保留账号。
        public: public 工作区。
        pi: pi 工作区。
        org_units: 最小组织树。
    """
    admin = users[ADMIN_EMAIL]
    hong = users[MAIN_PI_EMAIL]
    advisor = users[ADVISOR_EMAIL]
    student = users[STUDENT_EMAIL]
    member = users[MEMBER_EMAIL]
    root = org_units[ROOT_ORG_NAME]
    device = org_units[DEVICE_TEAM_NAME]
    for workspace in (public, pi):
        if workspace.owner_id != admin.id:
            workspace.owner = admin
            workspace.save(update_fields=["owner", "updated_at"])
    _ensure_workspace_member(public, admin, WORKSPACE_ADMIN_ROLE)
    _ensure_workspace_member(pi, admin, WORKSPACE_ADMIN_ROLE)
    _ensure_workspace_member(public, hong, WORKSPACE_MEMBER_ROLE)
    _ensure_workspace_member(pi, hong, WORKSPACE_MEMBER_ROLE)
    for user in (advisor, student, member):
        _ensure_workspace_member(public, user, WORKSPACE_MEMBER_ROLE)
        _hard_delete_queryset(WorkspaceMember.all_objects.filter(workspace=pi, member=user))
    _prune_pi_human_memberships(pi, allowed={admin.id, hong.id})
    _set_display_names(users)
    _ensure_research_settings(public, hong, WorkspaceResearchSetting.Purpose.PUBLIC_RESEARCH)
    _ensure_research_settings(pi, hong, WorkspaceResearchSetting.Purpose.PI_PRIVATE)
    _replace_main_pi_assignment(hong, admin)
    _hard_delete_queryset(OrgUnitMember.all_objects.exclude(user_id__in=[hong.id, advisor.id, student.id]))
    _hard_delete_queryset(
        OrgUnitMember.all_objects.filter(user=hong).exclude(org_unit=root, org_role=OrgUnitMember.OrgRole.PI)
    )
    _hard_delete_queryset(
        OrgUnitMember.all_objects.filter(user=advisor).exclude(org_unit=device, org_role=OrgUnitMember.OrgRole.ADVISOR)
    )
    _hard_delete_queryset(
        OrgUnitMember.all_objects.filter(user=student).exclude(org_unit=device, org_role=OrgUnitMember.OrgRole.REVIEWER)
    )
    _ensure_org_member(public, root, hong, OrgUnitMember.OrgRole.PI, is_primary=True)
    _ensure_org_member(public, device, advisor, OrgUnitMember.OrgRole.ADVISOR, is_primary=True)
    _ensure_org_member(public, device, student, OrgUnitMember.OrgRole.REVIEWER, is_primary=True)
    _hard_delete_queryset(MentorBinding.all_objects.exclude(mentee=student, mentor=advisor))
    _ensure_mentor_binding(public, device, student, advisor)
    _ensure_profile(hong, ResearchUserProfile.Category.PI)
    _ensure_profile(advisor, ResearchUserProfile.Category.ADVISOR)
    _ensure_profile(student, ResearchUserProfile.Category.STUDENT)
    _hard_delete_queryset(ResearchUserProfile.all_objects.filter(user=member))
    _hard_delete_queryset(ResearchUserProfile.all_objects.filter(user=admin))
    _hard_delete_queryset(
        ResearchWorkspaceAccessGrant.all_objects.exclude(user_id__in=[hong.id, admin.id]).exclude(user__is_bot=True)
    )
    _hard_delete_queryset(InstanceAdmin.all_objects.exclude(user=admin))


def _after_snapshot() -> dict:
    """采集清理后的关键对象数量。

    Returns:
        人类账号、bot、项目、组织与导师绑定计数。
    """
    return {
        "humans": User.objects.filter(is_bot=False).count(),
        "bots": User.objects.filter(is_bot=True).count(),
        "projects": Project.all_objects.count(),
        "chains": ResearchChain.all_objects.count(),
        "issues": Issue.all_objects.count(),
        "org_units": OrgUnit.all_objects.count(),
        "mentor_bindings": MentorBinding.all_objects.count(),
        "keep_users": list(User.objects.filter(is_bot=False).order_by("email").values_list("email", flat=True)),
    }


def _target_workspaces() -> list[Workspace]:
    """读取 public 与 pi 两个目标工作区。

    Returns:
        已存在的目标工作区列表。
    """
    return list(Workspace.objects.filter(slug__in=TARGET_WORKSPACE_SLUGS).order_by("slug"))


def _workspace_by_slug(workspaces: Iterable[Workspace], slug: str) -> Workspace | None:
    """按标识查找工作区。

    Args:
        workspaces: 候选工作区。
        slug: 工作区标识。

    Returns:
        匹配的工作区，不存在时为 None。
    """
    return next((workspace for workspace in workspaces if workspace.slug == slug), None)


def _keep_users() -> dict[str, User]:
    """读取保留名单中已存在的人类账号。

    Returns:
        小写邮箱到用户的映射。
    """
    users = {}
    for user in User.objects.filter(email__in=KEEP_HUMAN_EMAILS, is_bot=False):
        users[user.email.lower()] = user
    return users


def _missing_keep_emails(keep_users: dict[str, User]) -> list[str]:
    """列出尚未入库的保留邮箱。

    Args:
        keep_users: 已找到的保留账号。

    Returns:
        缺失邮箱，按字母序。
    """
    return sorted(KEEP_HUMAN_EMAILS - set(keep_users))


def _extra_human_users():
    """查询应删除的人类账号。

    Returns:
        不在保留名单中的非 bot 用户查询集。
    """
    return User.objects.filter(is_bot=False).exclude(email__in=KEEP_HUMAN_EMAILS)


def _planned_keep_org_ids(public: Workspace | None) -> set:
    """dry-run 时按名称识别将保留的组织节点。

    Args:
        public: public 工作区，缺失时视为没有可保留节点。

    Returns:
        将保留的组织节点主键。
    """
    if public is None:
        return set()
    return set(OrgUnit.all_objects.filter(workspace=public, name__in=ORG_KEEP_NAMES).values_list("id", flat=True))


def _ensure_named_unit(
    workspace: Workspace,
    name: str,
    *,
    parent: OrgUnit | None,
    unit_type: str,
    business_category: str | None,
    depth: int,
    sort_order: float,
) -> OrgUnit:
    """幂等取得指定名称的组织节点并校正层级。

    Args:
        workspace: 所属工作区。
        name: 节点名称。
        parent: 期望父节点，根节点为 None。
        unit_type: 节点类型。
        business_category: 业务方向。
        depth: 期望深度。
        sort_order: 排序值。

    Returns:
        校正后的组织节点。
    """
    unit = OrgUnit.all_objects.filter(workspace=workspace, name=name).order_by("created_at").first()
    if unit is None and parent is None:
        unit = OrgUnit.all_objects.filter(workspace=workspace, unit_type=OrgUnit.UnitType.ROOT).first()
        if unit is None:
            unit = OrgUnit.all_objects.filter(workspace=workspace, parent__isnull=True).first()
    if unit is None:
        unit = OrgUnit(
            workspace=workspace,
            name=name,
            parent=parent,
            unit_type=unit_type,
            business_category=business_category,
            depth=depth,
            sort_order=sort_order,
        )
        unit.save()
        unit.path = build_path(unit.id, parent.path if parent else None)
        unit.save(update_fields=["path", "updated_at"])
        return unit
    if parent is None:
        if unit.parent_id is not None:
            move_subtree(unit, None)
    elif unit.parent_id != parent.id:
        move_subtree(unit, parent)
    unit.name = name
    unit.unit_type = unit_type
    unit.business_category = business_category
    unit.depth = depth
    unit.sort_order = sort_order
    unit.is_active = True
    unit.deleted_at = None
    unit.path = build_path(unit.id, parent.path if parent else None)
    unit.save()
    return unit


def _delete_extra_org_units(*, keep_ids: set) -> int:
    """硬删除最小组织之外的全部节点。

    Args:
        keep_ids: 必须保留的组织节点主键。

    Returns:
        删除的节点数。
    """
    extra = list(OrgUnit.all_objects.exclude(id__in=keep_ids).order_by("-depth", "-created_at"))
    extra_ids = [unit.id for unit in extra]
    if not extra_ids:
        return 0
    _hard_delete_queryset(ResearchGroupKnowledgeBinding.all_objects.filter(org_unit_id__in=extra_ids))
    _delete_navigation_categories(ProjectNavigationCategory.all_objects.filter(org_unit_id__in=extra_ids))
    _hard_delete_queryset(OrgUnitMember.all_objects.filter(org_unit_id__in=extra_ids))
    _hard_delete_queryset(MentorBinding.all_objects.filter(org_unit_id__in=extra_ids))
    deleted = 0
    for unit in extra:
        unit.delete(soft=False)
        deleted += 1
    return deleted


def _delete_navigation_categories(queryset) -> None:
    """按子先父后的顺序硬删除导航分类，避开 parent PROTECT。

    Args:
        queryset: 待删除的导航分类。
    """
    remaining = {category.id: category for category in queryset}
    while remaining:
        child_parents = {category.parent_id for category in remaining.values() if category.parent_id in remaining}
        leaves = [category for category in remaining.values() if category.id not in child_parents] or list(
            remaining.values()
        )
        for category in leaves:
            category.delete(soft=False)
            remaining.pop(category.id, None)


def _restore_default_administrative_organizations(workspaces: Iterable[Workspace], admin: User) -> None:
    """业务清理后重建各工作区默认行政组织「公共」。

    Args:
        workspaces: 已清理的工作区。
        admin: 默认组织的创建者。
    """
    for workspace in workspaces:
        organization, created = AdministrativeOrganization.all_objects.get_or_create(
            workspace=workspace,
            is_default=True,
            defaults={"name": AdministrativeOrganization.PUBLIC_NAME, "created_by": admin},
        )
        if not created:
            organization.name = AdministrativeOrganization.PUBLIC_NAME
            organization.deleted_at = None
            organization.save(update_fields=["name", "deleted_at", "updated_at"])


def _reassign_workspace_owners(extra_ids: list, admin: User) -> None:
    """把待删账号拥有的工作区改挂到 admin，避免 CASCADE 删掉工作区。

    Args:
        extra_ids: 待删账号主键。
        admin: 接管人。
    """
    Workspace.all_objects.filter(owner_id__in=extra_ids).update(owner=admin)


def _clear_user_protect_relations(extra_ids: list, admin: User) -> None:
    """删除或改挂指向待删账号的 PROTECT 外键。

    Args:
        extra_ids: 待删账号主键。
        admin: 无法删除时的接管人。
    """
    for rel in User._meta.related_objects:
        field = getattr(rel, "field", None)
        if field is None or getattr(field.remote_field, "on_delete", None) is not models.PROTECT:
            continue
        model = rel.related_model
        column = field.name
        manager = getattr(model, "all_objects", model.objects)
        queryset = manager.filter(**{f"{column}__in": extra_ids})
        if model is AccountLink or model.__name__ == "AccountLink":
            _hard_delete_queryset(queryset)
            continue
        if issubclass(model, AppendOnlyModel):
            _reassign_append_only_user_fk(model, field, extra_ids, admin)
            continue
        if field.null:
            queryset.update(**{column: None})
        else:
            queryset.update(**{column: admin.pk})


def _ensure_workspace_member(workspace: Workspace, user: User, role: int) -> None:
    """恢复或创建指定角色的工作区成员。

    Args:
        workspace: 目标工作区。
        user: 成员账号。
        role: 工作区角色数值。
    """
    member = WorkspaceMember.all_objects.filter(workspace=workspace, member=user).order_by("-created_at").first()
    if member is None:
        WorkspaceMember.objects.create(workspace=workspace, member=user, role=role)
        return
    member.role = role
    member.is_active = True
    member.deleted_at = None
    member.save(update_fields=["role", "is_active", "deleted_at", "updated_at"])


def _prune_pi_human_memberships(pi: Workspace, *, allowed: set) -> None:
    """pi 工作区只保留 admin、洪文晶和 bot。

    Args:
        pi: pi 工作区。
        allowed: 允许保留的人类账号主键。
    """
    extras = WorkspaceMember.all_objects.filter(workspace=pi).exclude(member_id__in=allowed).select_related("member")
    for member in extras:
        if member.member is not None and member.member.is_bot:
            continue
        member.delete(soft=False)


def _set_display_names(users: dict[str, User]) -> None:
    """把科研测试账号的显示名校正为真实姓名。

    Args:
        users: 保留账号映射。
    """
    for email, name in KEEP_DISPLAY_NAMES.items():
        user = users.get(email)
        if user is None:
            continue
        if user.display_name != name or user.first_name != name:
            user.display_name = name
            user.first_name = name
            user.save(update_fields=["display_name", "first_name", "updated_at"])


def _ensure_research_settings(workspace: Workspace, main_pi: User, purpose: str) -> WorkspaceResearchSetting:
    """启用科研模块并指定主 PI。

    Args:
        workspace: 目标工作区。
        main_pi: 洪文晶账号。
        purpose: 工作区用途。

    Returns:
        更新后的科研配置。
    """
    setting, _ = WorkspaceResearchSetting.all_objects.get_or_create(workspace=workspace)
    setting.purpose = purpose
    setting.main_pi = main_pi
    setting.module_enabled = True
    setting.org_enabled = True
    setting.deleted_at = None
    setting.save()
    return setting


def _replace_main_pi_assignment(user: User, actor: User) -> None:
    """保证实例 MAIN_PI 标签只属于洪文晶。

    Args:
        user: 洪文晶账号。
        actor: 标签授予人。
    """
    _hard_delete_queryset(InstanceRoleAssignment.all_objects.filter(role=MAIN_PI).exclude(user=user))
    assignment = InstanceRoleAssignment.all_objects.filter(user=user, role=MAIN_PI).first()
    if assignment is None:
        InstanceRoleAssignment.objects.create(user=user, role=MAIN_PI, assigned_by=actor, note="dev prune")
        return
    assignment.deleted_at = None
    assignment.assigned_by = actor
    assignment.note = "dev prune"
    assignment.save(update_fields=["deleted_at", "assigned_by", "note", "updated_at"])


def _ensure_org_member(workspace: Workspace, unit: OrgUnit, user: User, role: str, *, is_primary: bool) -> None:
    """幂等恢复一条组织成员关系。

    Args:
        workspace: 工作区。
        unit: 组织节点。
        user: 成员。
        role: 组织角色。
        is_primary: 是否主组织关系。
    """
    if is_primary:
        OrgUnitMember.all_objects.filter(workspace=workspace, user=user, is_primary=True).exclude(org_unit=unit).update(
            is_primary=False
        )
    member = OrgUnitMember.all_objects.filter(workspace=workspace, org_unit=unit, user=user, org_role=role).first()
    if member is None:
        OrgUnitMember.objects.create(
            workspace=workspace,
            org_unit=unit,
            user=user,
            org_role=role,
            is_primary=is_primary,
        )
        return
    member.is_primary = is_primary
    member.effective_from = timezone.localdate()
    member.effective_to = None
    member.deleted_at = None
    member.save(update_fields=["is_primary", "effective_from", "effective_to", "deleted_at", "updated_at"])


def _ensure_mentor_binding(workspace: Workspace, unit: OrgUnit, mentee: User, mentor: User) -> None:
    """保证学生只有一条指向直接导师的主导师绑定。

    Args:
        workspace: 工作区。
        unit: 组织节点。
        mentee: 学生。
        mentor: 直接导师。
    """
    _hard_delete_queryset(MentorBinding.all_objects.filter(workspace=workspace, mentee=mentee).exclude(mentor=mentor))
    binding = MentorBinding.all_objects.filter(workspace=workspace, mentee=mentee, mentor=mentor).first()
    if binding is None:
        MentorBinding.objects.create(
            workspace=workspace,
            mentee=mentee,
            mentor=mentor,
            org_unit=unit,
            is_primary_advisor=True,
        )
        return
    binding.org_unit = unit
    binding.is_primary_advisor = True
    binding.effective_from = timezone.localdate()
    binding.effective_to = None
    binding.deleted_at = None
    binding.save()


def _ensure_profile(user: User, category: str) -> None:
    """为科研身份补齐 Profile。

    Args:
        user: 目标账号。
        category: 人员类别。
    """
    profile = ResearchUserProfile.all_objects.filter(user=user).first()
    if profile is None:
        ResearchUserProfile.objects.create(user=user, category=category)
        return
    profile.category = category
    profile.deleted_at = None
    profile.save(update_fields=["category", "deleted_at", "updated_at"])


def _reassign_append_only_user_fk(model, field, extra_ids: list, admin: User) -> None:
    """用 SQL 改挂 append-only 表上无法 ORM 更新的用户外键。

    Args:
        model: append-only 模型。
        field: 指向 User 的外键字段。
        extra_ids: 待删账号主键。
        admin: 接管人。
    """
    if not extra_ids:
        return
    table = model._meta.db_table
    column = field.column
    placeholders = ", ".join(["%s"] * len(extra_ids))
    params = [str(user_id) for user_id in extra_ids]
    with connection.cursor() as cursor:
        if field.null:
            cursor.execute(
                f'UPDATE "{table}" SET "{column}" = NULL WHERE "{column}" IN ({placeholders})',
                params,
            )
        else:
            cursor.execute(
                f'UPDATE "{table}" SET "{column}" = %s WHERE "{column}" IN ({placeholders})',
                [str(admin.pk), *params],
            )


def _hard_delete_queryset(queryset) -> int:
    """硬删除查询集；不支持 soft 参数时回退到默认删除。

    Args:
        queryset: 待删除查询集。

    Returns:
        Django 返回的删除计数；无法取得时为 0。
    """
    try:
        deleted, _ = queryset.delete(soft=False)
    except TypeError:
        deleted, _ = queryset.delete()
    except ProtectedError:
        for row in list(queryset):
            row.delete(soft=False)
        return 0
    return deleted
