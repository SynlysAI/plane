"""Native Issue saves and existing post-commit effects shared by Web and MCP.

Validation remains in the native serializers; this is not a second task model.
"""

import json

from crum import impersonate
from django.core.serializers.json import DjangoJSONEncoder
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied

from plane.app.permissions.base import ROLE, project_role_allows
from plane.bgtasks.issue_activities_task import issue_activity
from plane.bgtasks.issue_description_version_task import issue_description_version_task
from plane.bgtasks.webhook_task import model_activity
from plane.db.models import Issue, ProjectMember, UserRecentVisit, WorkspaceMember
from plane.utils.host import base_host
from plane.utils.project_domains import project_domain_allows
from plane.utils.workspace_access import user_can_access_workspace


def issue_action_allowed(actor, project, action, issue=None):
    """Match native create/edit-creator/comment rules without creating memberships."""
    if (
        not actor
        or not actor.is_active
        or not user_can_access_workspace(actor, workspace_id=project.workspace_id)
        or not WorkspaceMember.objects.filter(workspace_id=project.workspace_id, member=actor, is_active=True).exists()
        or not project_domain_allows(actor, project.workspace.slug, project.pk, write=True)
    ):
        return False
    if action == "update" and issue is not None and issue.created_by_id == actor.pk:
        return True
    roles = [ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST] if action == "comment" else [ROLE.ADMIN, ROLE.MEMBER]
    if not project_role_allows(actor, project.workspace.slug, project.pk, roles):
        return False
    if action == "comment" and issue is not None:
        if (
            not project.guest_view_all_features
            and issue.created_by_id != actor.pk
            and ProjectMember.objects.filter(
                project=project, workspace_id=project.workspace_id, member=actor, role=ROLE.GUEST.value, is_active=True
            ).exists()
        ):
            return False
    return True


def issue_delete_allowed(actor, project, issue):
    """Match the native issue-delete rule for project admins and creators."""
    if (
        not actor
        or not actor.is_active
        or not WorkspaceMember.objects.filter(workspace_id=project.workspace_id, member=actor, is_active=True).exists()
    ):
        return False
    return issue.created_by_id == actor.pk or project_role_allows(
        actor, project.workspace.slug, project.pk, [ROLE.ADMIN]
    )


def soft_delete_issue(issue: Issue, actor, request) -> None:
    """Soft-delete an issue and emit the native deleted activity effect.

    Args:
        issue: Target native work item.
        actor: Human actor who authorized deletion.
        request: Native or MCP request used to resolve the activity origin.
    """
    issue_id = issue.pk
    project_id = issue.project_id
    issue.delete()
    UserRecentVisit.objects.filter(
        project_id=project_id,
        workspace=issue.workspace,
        entity_identifier=issue_id,
        entity_name="issue",
    ).delete(soft=False)
    _commit_task(
        issue_activity,
        type="issue.activity.deleted",
        requested_data=json.dumps({"issue_id": str(issue_id)}),
        actor_id=str(actor.pk),
        issue_id=str(issue_id),
        project_id=str(project_id),
        current_instance={},
        epoch=int(timezone.now().timestamp()),
        notification=True,
        origin=base_host(request=request, is_app=True),
        subscriber=False,
    )


def _commit_task(task, **kwargs):
    # Each callback is independent: a failed broker publish cannot turn a
    # committed task into a reported rollback or suppress the other effects.
    def publish():
        task.delay(**kwargs)

    transaction.on_commit(publish, robust=True)


def _effects(*, model, instance, actor, request, data, previous, creating):
    origin = base_host(request=request, is_app=True) if request is not None else None
    is_comment = model == "issue_comment"
    issue_id = instance.issue_id if is_comment else instance.pk
    _commit_task(
        issue_activity,
        type=("comment" if is_comment else "issue") + ".activity." + ("created" if creating else "updated"),
        requested_data=json.dumps(data, cls=DjangoJSONEncoder),
        current_instance=previous,
        actor_id=str(actor.pk),
        issue_id=str(issue_id),
        project_id=str(instance.project_id),
        epoch=int(timezone.now().timestamp()),
        notification=True,
        origin=origin,
    )
    _commit_task(
        model_activity,
        model_name=model,
        model_id=str(instance.pk),
        requested_data=data,
        current_instance=previous,
        actor_id=actor.pk,
        slug=instance.workspace.slug,
        origin=origin,
    )
    if not is_comment:
        kwargs = {
            "updated_issue": json.dumps(data, cls=DjangoJSONEncoder) if creating else previous,
            "issue_id": str(issue_id),
            "user_id": actor.pk,
        }
        if creating:
            kwargs["is_creating"] = True
        _commit_task(issue_description_version_task, **kwargs)


@transaction.atomic
def save_issue(*, serializer, project, actor, request=None, previous=None, skip_effects=False):
    creating = serializer.instance is None
    if not issue_action_allowed(actor, project, "create" if creating else "update", serializer.instance):
        raise PermissionDenied("You do not have permission to change this work item.")
    with impersonate(actor):
        issue = serializer.save()
    if not skip_effects:
        data = dict(serializer.initial_data)
        for field in ("name", "description_html"):
            if field in data:
                data[field] = getattr(issue, field)
        _effects(
            model="issue", instance=issue, actor=actor, request=request, data=data, previous=previous, creating=creating
        )
    return issue


@transaction.atomic
def save_issue_comment(*, serializer, issue, actor, request=None):
    if not issue_action_allowed(actor, issue.project, "comment", issue):
        raise PermissionDenied("You do not have permission to comment on this work item.")
    with impersonate(actor):
        comment = serializer.save(project_id=issue.project_id, issue_id=issue.pk, actor=actor)
    _effects(
        model="issue_comment",
        instance=comment,
        actor=actor,
        request=request,
        data=dict(serializer.data),
        previous=None,
        creating=True,
    )
    return comment
