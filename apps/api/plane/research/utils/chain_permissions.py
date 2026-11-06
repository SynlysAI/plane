"""研究链按项目归属组织派生的可见性与科研成员范围。"""

from django.db.models import Q

from plane.db.models import OrgUnit, OrgUnitMember, ResearchProjectProfile, WorkspaceMember
from plane.license.models import InstanceAdmin
from plane.research.utils.capabilities import org_signal_workspace
from plane.research.utils.org import READABLE_WORKSPACE_ROLES, active_membership_q
from plane.research.utils.todo_context import reuse_todo_query

BUSINESS_CATEGORIES = frozenset(("BASIC_RESEARCH", "INDUSTRIALIZATION"))


def basic_research_unit_ids(workspace):
    """批量识别最近业务方向为基础研究的有效组织。

    Args:
        workspace: 科研项目所在工作区。

    Returns:
        基础研究组织及其未覆盖业务方向的后代组织主键集合。
    """
    units = {
        unit.id: unit
        for unit in OrgUnit.objects.filter(workspace=workspace, is_active=True, deleted_at__isnull=True).only(
            "id", "parent_id", "business_category"
        )
    }
    result = set()
    for unit_id, unit in units.items():
        visited = set()
        while unit is not None and unit.id not in visited:
            visited.add(unit.id)
            if unit.business_category in BUSINESS_CATEGORIES:
                if unit.business_category == OrgUnit.BusinessCategory.BASIC_RESEARCH:
                    result.add(unit_id)
                break
            unit = units.get(unit.parent_id)
    return result


@reuse_todo_query
def is_basic_research_chain(profile):
    """根据项目归属组织识别是否采用基础研究链开放策略。

    Args:
        profile: 科研项目档案，允许为空。

    Returns:
        仅有效组织下的基础研究链返回 True，旧培养项目保持原规则。
    """
    if profile is None or profile.chain_kind != ResearchProjectProfile.ChainKind.RESEARCH_CHAIN:
        return False
    unit = profile.org_unit
    visited = set()
    while unit is not None and unit.id not in visited:
        if unit.workspace_id != profile.workspace_id or not unit.is_active or unit.deleted_at is not None:
            return False
        visited.add(unit.id)
        if unit.business_category in BUSINESS_CATEGORIES:
            return unit.business_category == OrgUnit.BusinessCategory.BASIC_RESEARCH
        unit = unit.parent
    return False


def effective_chain_visibility(profile, *, configured_visibility=None):
    """返回研究链实际使用的可见性，保留数据库中的原始配置。

    Args:
        profile: 科研项目档案。
        configured_visibility: 研究链原有可见性；省略时使用项目档案配置。

    Returns:
        基础研究链固定为 WORKSPACE，其他项目沿用已有可见性。
    """
    if is_basic_research_chain(profile):
        return "WORKSPACE"
    return configured_visibility if configured_visibility is not None else profile.chain_visibility


def research_workspace_members(workspace):
    """查询账号、席位与科研身份均有效的工作区成员。

    Args:
        workspace: 候选人必须持有有效席位的工作区。

    Returns:
        与现有科研 API 组织门禁一致的工作区成员查询集，包含科研管理员。
    """
    signal_workspace = org_signal_workspace(workspace)
    org_members = OrgUnitMember.objects.filter(
        active_membership_q(),
        workspace=signal_workspace,
        org_unit__workspace=signal_workspace,
        org_unit__is_active=True,
        org_unit__deleted_at__isnull=True,
    ).values("user_id")
    instance_admins = InstanceAdmin.objects.filter(role__gte=15).values("user_id")
    return WorkspaceMember.objects.filter(
        Q(member_id__in=org_members) | Q(role=20) | Q(member_id__in=instance_admins),
        workspace=workspace,
        member__is_active=True,
        role__in=READABLE_WORKSPACE_ROLES,
        is_active=True,
        deleted_at__isnull=True,
    )


@reuse_todo_query
def is_research_workspace_member(workspace, user):
    """判断用户是否持有本工作区有效科研身份。

    Args:
        workspace: 当前工作区。
        user: 待检查的登录用户。

    Returns:
        有效科研成员或管理员返回 True。
    """
    return bool(
        user is not None
        and getattr(user, "is_authenticated", False)
        and research_workspace_members(workspace).filter(member=user).exists()
    )
