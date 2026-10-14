"""行政项目的默认管理权限，独立于显式项目成员关系。"""

from django.db import IntegrityError, transaction
from django.db.models import Q

from plane.db.models import (
    AdministrativeOrganization,
    AdministrativeOrganizationMember,
    Project,
    ProjectMember,
    ResearchChain,
    ResearchProjectProfile,
    Workspace,
    WorkspaceMember,
)
from plane.db.models.project import ROLE
from plane.utils.workspace_access import user_can_access_workspace


def research_project_ids():
    """返回所有科研档案或科研链关联的项目 ID。

    Returns:
        包含软删除科研档案的项目主键查询集。
    """
    profile_ids = ResearchProjectProfile.all_objects.values("project_id")
    chain_ids = ResearchChain.all_objects.values("project_id")
    return profile_ids.union(chain_ids)


def administrative_project_filter(prefix=""):
    """返回排除科研项目的 Django 查询条件。

    Args:
        prefix: 关联项目字段前缀；项目查询使用空字符串，工作项查询使用 ``project__``。

    Returns:
        排除科研项目的 Q 条件。
    """
    field = f"{prefix}id__in" if prefix else "id__in"
    return ~Q(**{field: research_project_ids()})


def administrative_projects(workspace_slug):
    """返回工作区内未关联科研档案的行政项目。

    Args:
        workspace_slug: 工作区别名。

    Returns:
        行政项目查询集。
    """
    return Project.objects.filter(workspace__slug=workspace_slug).filter(administrative_project_filter())


def administrative_projects_for_user(user, workspace_slug):
    """返回当前身份默认拥有管理权限的行政项目。

    Args:
        user: 当前用户。
        workspace_slug: 工作区别名。

    Returns:
        行政项目查询集；未获工作区准入或没有管理身份时为空。
    """
    projects = administrative_projects(workspace_slug)
    if user is None or not getattr(user, "is_authenticated", False):
        return projects.none()
    if not user_can_access_workspace(user, workspace_slug=workspace_slug):
        return projects.none()
    membership = WorkspaceMember.objects.filter(
        workspace__slug=workspace_slug,
        member=user,
        is_active=True,
        deleted_at__isnull=True,
    ).first()
    if membership is None:
        return projects.none()

    from plane.research.utils.roles import is_instance_admin, is_main_pi

    if membership.role == ROLE.ADMIN.value or is_instance_admin(user) or is_main_pi(user, membership.workspace_id):
        return projects
    return projects.none()


def administrative_organization_project_ids(user, workspace_slug):
    """返回用户通过行政组织成员身份可读取的行政项目 ID。"""
    if user is None or not getattr(user, "is_authenticated", False):
        return Project.objects.none().values("id")
    return (
        Project.objects.filter(
            workspace__slug=workspace_slug,
            administrative_organization__members__member=user,
            administrative_organization__members__is_active=True,
            administrative_organization__members__deleted_at__isnull=True,
            administrative_organization__deleted_at__isnull=True,
            deleted_at__isnull=True,
        )
        .exclude(id__in=research_project_ids())
        .values("id")
    )


def public_administrative_project_ids(user, workspace_slug):
    """返回对所有有效工作区成员开放的公共行政项目 ID。

    Args:
        user: 当前用户。
        workspace_slug: 工作区别名。

    Returns:
        公共行政项目 ID 查询集；无效用户返回空查询集。
    """
    if user is None or not getattr(user, "is_authenticated", False):
        return Project.objects.none().values("id")
    return (
        Project.objects.filter(
            workspace__slug=workspace_slug,
            workspace__workspace_member__member=user,
            workspace__workspace_member__is_active=True,
            workspace__workspace_member__deleted_at__isnull=True,
            administrative_organization__is_default=True,
            administrative_organization__deleted_at__isnull=True,
            deleted_at__isnull=True,
        )
        .exclude(id__in=research_project_ids())
        .values("id")
    )


def get_or_create_default_administrative_organization(workspace):
    """Return the unique default administrative organization for a workspace.

    Args:
        workspace: The workspace model instance or primary key.

    Returns:
        The active default organization, or None when the workspace is invalid.
    """
    if workspace is None:
        return None
    workspace_id = workspace.pk if hasattr(workspace, "pk") else workspace
    organization = AdministrativeOrganization.objects.filter(
        workspace_id=workspace_id, is_default=True, deleted_at__isnull=True
    ).first()
    if organization is not None:
        return organization
    try:
        with transaction.atomic():
            return AdministrativeOrganization.objects.create(
                workspace_id=workspace_id,
                name=AdministrativeOrganization.PUBLIC_NAME,
                is_default=True,
            )
    except IntegrityError:
        return AdministrativeOrganization.objects.filter(
            workspace_id=workspace_id, is_default=True, deleted_at__isnull=True
        ).first()


def user_can_manage_administrative_organization(user, workspace_slug, organization_id):
    """判断用户是否可管理指定行政组织及其成员。"""
    if not user or not getattr(user, "is_authenticated", False) or not organization_id:
        return False
    if WorkspaceMember.objects.filter(
        workspace__slug=workspace_slug,
        member=user,
        is_active=True,
        deleted_at__isnull=True,
        role=ROLE.ADMIN.value,
    ).exists():
        return True
    return AdministrativeOrganizationMember.objects.filter(
        workspace__slug=workspace_slug,
        organization_id=organization_id,
        member=user,
        role=AdministrativeOrganizationMember.Role.ADMIN,
        is_active=True,
        deleted_at__isnull=True,
        organization__deleted_at__isnull=True,
    ).exists()


def user_can_administer_administrative_organization(user, workspace_slug, organization_id):
    """判断用户是否可管理组织成员与项目归属。"""
    return user_can_manage_administrative_organization(user, workspace_slug, organization_id)


def visible_administrative_projects(user, workspace_slug):
    """返回当前用户可读取的行政项目，兼容默认管理员权限。

    Args:
        user: 当前用户。
        workspace_slug: 工作区别名。

    Returns:
        已按工作区准入及有效成员权限限定的行政项目查询集。
    """
    projects = administrative_projects(workspace_slug)
    if not user or not getattr(user, "is_authenticated", False):
        return projects.none()
    if not user_can_access_workspace(user, workspace_slug=workspace_slug):
        return projects.none()
    member_ids = ProjectMember.objects.filter(workspace__slug=workspace_slug, member=user, is_active=True).values(
        "project_id"
    )
    return projects.filter(
        Q(id__in=member_ids)
        | Q(id__in=public_administrative_project_ids(user, workspace_slug))
        | Q(id__in=administrative_organization_project_ids(user, workspace_slug))
        | Q(id__in=administrative_projects_for_user(user, workspace_slug).values("id"))
    )


def restrict_administrative_project_visibility(queryset, user, workspace_slug):
    """限制行政项目为有效成员或默认管理身份可见。

    Args:
        queryset: 已按工作区限定的项目查询集。
        user: 当前用户。
        workspace_slug: 工作区别名。

    Returns:
        过滤后的项目查询集，科研项目沿用调用方的访问规则。
    """
    member_ids = ProjectMember.objects.filter(workspace__slug=workspace_slug, member=user, is_active=True).values(
        "project_id"
    )
    return queryset.filter(
        Q(id__in=research_project_ids())
        | Q(id__in=member_ids)
        | Q(id__in=public_administrative_project_ids(user, workspace_slug))
        | Q(id__in=administrative_organization_project_ids(user, workspace_slug))
        | Q(id__in=administrative_projects_for_user(user, workspace_slug).values("id"))
    )


def user_can_manage_administrative_project(user, workspace_slug, project_id):
    """判断用户是否默认拥有指定行政项目的管理权限。

    Args:
        user: 当前用户。
        workspace_slug: 工作区别名。
        project_id: 项目主键。

    Returns:
        当前身份可以管理该行政项目时为 True。
    """
    if not workspace_slug or not project_id:
        return False
    return administrative_projects_for_user(user, workspace_slug).filter(id=project_id).exists()


def effective_project_member(user, workspace_slug, project_id):
    """返回显式成员或用于权限检查的临时行政项目管理员。

    Args:
        user: 当前用户。
        workspace_slug: 工作区别名。
        project_id: 项目主键。

    Returns:
        ProjectMember 对象；临时对象不保存到数据库，没有权限时为 None。
    """
    member = ProjectMember.objects.filter(
        workspace__slug=workspace_slug, project_id=project_id, member=user, is_active=True
    ).first()
    public_member = public_administrative_project_ids(user, workspace_slug).filter(id=project_id).exists()
    organization_member = administrative_organization_project_ids(user, workspace_slug).filter(id=project_id).exists()
    if user_can_manage_administrative_project(user, workspace_slug, project_id):
        return ProjectMember(
            id=member.id if member else None,
            member=user,
            project_id=project_id,
            workspace_id=Workspace.objects.values_list("id", flat=True).get(slug=workspace_slug),
            role=ROLE.ADMIN.value,
        )
    if public_member:
        role = max(member.role, ROLE.MEMBER.value) if member is not None else ROLE.MEMBER.value
        return ProjectMember(
            id=member.id if member else None,
            member=user,
            project_id=project_id,
            workspace_id=Workspace.objects.values_list("id", flat=True).get(slug=workspace_slug),
            role=role,
        )
    if organization_member and member is None:
        return ProjectMember(
            member=user,
            project_id=project_id,
            workspace_id=Workspace.objects.values_list("id", flat=True).get(slug=workspace_slug),
            role=ROLE.GUEST.value,
        )
    return member
