"""Project lifecycle effects shared by the native API and MCP writers."""

from django.db import transaction
from django.utils import timezone

from plane.bgtasks.webhook_task import model_activity, webhook_activity
from plane.db.models import DeployBoard, UserFavorite
from plane.utils.home_activity import record_project_activity
from plane.utils.host import base_host


def queue_project_model_activity(project, actor, request, requested_data, current_instance=None):
    """Queue the same project webhook event used by the native project API.

    Args:
        project: Created or updated project.
        actor: Human actor who authorized the mutation.
        request: Native or MCP request used to resolve the webhook origin.
        requested_data: Bounded mutation payload.
        current_instance: Optional pre-update serialized project value.
    """
    transaction.on_commit(
        lambda: model_activity.delay(
            model_name="project",
            model_id=str(project.id),
            requested_data=requested_data,
            current_instance=current_instance,
            actor_id=actor.id,
            slug=project.workspace.slug,
            origin=base_host(request=request, is_app=True),
        ),
        robust=True,
    )


def set_project_archived(project, actor, *, archived):
    """Archive or restore a project with native activity and favorite cleanup.

    Args:
        project: Target project.
        actor: Human actor who authorized the lifecycle change.
        archived: Whether the project should be archived.
    """
    project.archived_at = timezone.now() if archived else None
    project.save(update_fields=["archived_at", "updated_at"])
    record_project_activity(project, actor, "archived" if archived else "restored")
    if archived:
        UserFavorite.objects.filter(workspace=project.workspace, project=project).delete()


def soft_delete_project(project, actor, request):
    """Soft-delete a project with native activity, webhook and cleanups.

    Args:
        project: Target project.
        actor: Human actor who authorized deletion.
        request: Native or MCP request used to resolve the webhook origin.
    """
    project_id = project.id
    slug = project.workspace.slug
    record_project_activity(project, actor, "deleted")
    project.delete()
    DeployBoard.objects.filter(project_id=project_id, workspace__slug=slug).delete()
    UserFavorite.objects.filter(project_id=project_id, workspace__slug=slug).delete()
    transaction.on_commit(
        lambda: webhook_activity.delay(
            event="project",
            verb="deleted",
            field=None,
            old_value=None,
            new_value=None,
            actor_id=actor.id,
            slug=slug,
            current_site=base_host(request=request, is_app=True),
            event_id=project_id,
            old_identifier=None,
            new_identifier=None,
        ),
        robust=True,
    )
