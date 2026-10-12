"""行政项目的默认管理权限，独立于显式项目成员关系。"""

from django.db.models import Q

from plane.db.models import Project, ProjectMember, ResearchChain, ResearchProjectProfile, Workspace, WorkspaceMember
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
    membership = WorkspaceMember.objects.filter(workspace__slug=workspace_slug, member=user, is_active=True).first()
    if membership is None:
        return projects.none()

    from plane.research.utils.roles import is_instance_admin, is_main_pi

    if membership.role == ROLE.ADMIN.value or is_instance_admin(user) or is_main_pi(user, membership.workspace_id):
        return projects
    return projects.none()


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
    member_ids = ProjectMember.objects.filter(
        workspace__slug=workspace_slug, member=user, is_active=True
    ).values("project_id")
    return projects.filter(
        Q(id__in=member_ids)
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
    if user_can_manage_administrative_project(user, workspace_slug, project_id):
        return ProjectMember(
            id=member.id if member else None,
            member=user,
            project_id=project_id,
            workspace_id=Workspace.objects.values_list("id", flat=True).get(slug=workspace_slug),
            role=ROLE.ADMIN.value,
        )
    return member
