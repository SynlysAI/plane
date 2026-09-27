# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""研究链只读读者。

课题总览已经按导师、组织管理和主 PI 放行，但 Plane 项目列表仍只看
``ProjectMember``。这里复用同一套关系，只给私有科研项目补只读入口，
不写入成员行，也不把同组学生或普通工作区成员算进去。
"""

from django.db.models import Q
from django.utils import timezone

from plane.db.models import MentorBinding, OrgUnit, OrgUnitMember, ResearchProjectProfile, Workspace
from plane.research.utils.acl import models_q_expired
from plane.research.utils.roles import configured_main_pi_id

REVIEW_ORG_ROLES = (OrgUnitMember.OrgRole.PI, OrgUnitMember.OrgRole.OWNER)


def pi_owner_scope_unit_ids(user, workspace_id, on_date=None):
    """返回用户以 PI 或 OWNER 管辖的组织节点及其后代。

    Args:
        user: 当前查看者。
        workspace_id: 工作区主键。
        on_date: 关系生效日，默认今天。

    Returns:
        可见组织节点主键集合。没有管辖节点时为空集。
    """
    on_date = on_date or timezone.localdate()
    paths = list(
        OrgUnitMember.objects.filter(
            deleted_at__isnull=True,
            workspace_id=workspace_id,
            user=user,
            org_role__in=REVIEW_ORG_ROLES,
            effective_from__lte=on_date,
        )
        .filter(models_q_expired(on_date))
        .values_list("org_unit__path", flat=True)
        .distinct()
    )
    query = Q()
    for path in paths:
        if path:
            query |= Q(path__startswith=path)
    if not query:
        return set()
    return set(
        OrgUnit.objects.filter(
            workspace_id=workspace_id,
            deleted_at__isnull=True,
            is_active=True,
        )
        .filter(query)
        .values_list("id", flat=True)
    )


def research_review_profiles(workspace, user, on_date=None):
    """返回查看者可以只读打开的科研项目档案。

    Args:
        workspace: 工作区。
        user: 当前查看者。
        on_date: 关系生效日，默认今天。

    Returns:
        ``ResearchProjectProfile`` 查询集。未登录或没有资格时为空查询集。
    """
    if user is None or not getattr(user, "is_authenticated", False):
        return ResearchProjectProfile.objects.none()
    on_date = on_date or timezone.localdate()
    profiles = ResearchProjectProfile.objects.filter(
        workspace=workspace,
        deleted_at__isnull=True,
        project__deleted_at__isnull=True,
    )
    if configured_main_pi_id(workspace) == user.id:
        return profiles
    mentee_ids = MentorBinding.objects.filter(
        deleted_at__isnull=True,
        workspace=workspace,
        mentor=user,
        effective_from__lte=on_date,
    ).filter(models_q_expired(on_date)).values("mentee_id")
    unit_ids = pi_owner_scope_unit_ids(user, workspace.id, on_date)
    return profiles.filter(Q(owner_id__in=mentee_ids) | Q(org_unit_id__in=unit_ids)).distinct()


def research_review_project_ids_for_slug(user, workspace_slug, on_date=None):
    """按工作区别名返回只读科研项目主键。

    Args:
        user: 当前查看者。
        workspace_slug: 工作区别名。
        on_date: 关系生效日，默认今天。

    Returns:
        项目主键列表。工作区不存在时为空列表。
    """
    workspace = Workspace.objects.filter(slug=workspace_slug).first()
    if workspace is None:
        return []
    return list(research_review_profiles(workspace, user, on_date).values_list("project_id", flat=True))


def user_can_review_research_project(user, workspace_slug, project_id, on_date=None) -> bool:
    """判断查看者能否只读打开指定科研项目。

    Args:
        user: 当前查看者。
        workspace_slug: 工作区别名。
        project_id: Plane 项目主键。
        on_date: 关系生效日，默认今天。

    Returns:
        属于研究链只读范围时为 True。项目成员身份不在这里判断。
    """
    workspace = Workspace.objects.filter(slug=workspace_slug).first()
    if workspace is None or project_id is None:
        return False
    return research_review_profiles(workspace, user, on_date).filter(project_id=project_id).exists()
