"""Project domain and admission rules shared by navigation and Plane resources."""

from plane.db.models import Project, ProjectMember, ResearchProjectProfile, Workspace, WorkspaceMember
from plane.utils.administrative_projects import research_project_ids, effective_project_member
from plane.utils.workspace_access import user_can_access_workspace


def research_admitted(user, workspace):
    from plane.research.utils.capabilities import has_active_research_org_relation
    from plane.research.utils.settings import workspace_research_enabled

    return bool(
        workspace
        and WorkspaceMember.objects.filter(workspace=workspace, member=user, is_active=True).exists()
        and user_can_access_workspace(user, workspace_slug=workspace.slug)
        and workspace_research_enabled(workspace)
        and has_active_research_org_relation(user, workspace)
    )


def project_domain_allows(user, slug, project_id, *, write=False):
    """An additional domain gate; existing resource permissions still apply."""
    if not user_can_access_workspace(user, workspace_slug=slug) or not WorkspaceMember.objects.filter(
        workspace__slug=slug, member=user, is_active=True
    ).exists():
        return False
    project = Project.objects.filter(pk=project_id, workspace__slug=slug).select_related("workspace").first()
    if project is None:
        return False
    if Project.all_objects.filter(pk=project_id, id__in=research_project_ids()).exists():
        if not research_admitted(user, project.workspace):
            return False
        profile = ResearchProjectProfile.objects.filter(project=project).first()
        if profile is None:
            return False
        from plane.research.views.projects import can_read_project_research_metadata

        if not can_read_project_research_metadata(project.workspace, user, profile):
            return False
        if write:
            return ProjectMember.objects.filter(
                project=project, member=user, is_active=True, role__gte=15
            ).exists()
        return True
    member = effective_project_member(user, slug, project_id)
    return member is not None and (not write or member.role >= 15)


def initialize_workspace_research(workspace, enabled=False, purpose="GENERAL", actor=None):
    """Both workspace creation endpoints must persist the same explicit defaults."""
    from plane.db.models import WorkspaceResearchSetting
    from plane.research.utils.org import ensure_root_org_unit

    setting = WorkspaceResearchSetting.objects.create(
        workspace=workspace,
        purpose=purpose,
        module_enabled=enabled and purpose != "PI_PRIVATE",
        research_chain_enabled=True,
        created_by=actor,
    )
    if setting.module_enabled:
        ensure_root_org_unit(workspace)
    return setting
