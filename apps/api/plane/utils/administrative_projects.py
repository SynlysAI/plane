"""行政项目的默认管理权限，独立于显式项目成员关系。"""

from django.db.models import Q

from plane.db.models import Project, ProjectMember, ResearchProjectProfile, Workspace, WorkspaceMember
from plane.db.models.project import ROLE
from plane.utils.workspace_access import user_can_access_workspace


def administrative_projects(workspace_slug):
    """返回工作区内未关联科研档案的行政项目。

    Args:
        workspace_slug: 工作区别名。

    Returns:
        行政项目查询集。
    """
    return Project.objects.filter(workspace__slug=workspace_slug).exclude(
        id__in=ResearchProjectProfile.objects.values("project_id")
    )


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
        Q(id__in=ResearchProjectProfile.objects.values("project_id"))
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
