"""行政项目的默认管理权限，独立于显式项目成员关系。"""

from plane.db.models import Project, ProjectMember, ResearchProjectProfile, Workspace, WorkspaceMember
from plane.db.models.project import ROLE
from plane.utils.workspace_access import user_can_access_workspace


def administrative_projects_for_user(user, workspace_slug):
    """返回当前身份默认拥有管理权限的行政项目。

    Args:
        user: 当前用户。
        workspace_slug: 工作区别名。

    Returns:
        行政项目查询集；未获工作区准入或没有管理身份时为空。
    """
    projects = Project.objects.filter(workspace__slug=workspace_slug).exclude(
        id__in=ResearchProjectProfile.objects.values("project_id")
    )
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
