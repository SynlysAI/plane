"""Helpers for recording meaningful home-feed business events."""

from django.utils import timezone

from plane.db.models import HomeActivityEvent, User


def actor_display(user):
    """Return a stable display name for a nullable actor.

    Args:
        user: The user who performed an action, or ``None``.

    Returns:
        A short display string used in event summaries.
    """
    if user is None:
        return ""
    return user.display_name or " ".join(part for part in (user.first_name, user.last_name) if part) or user.email


def record_project_activity(project, actor, action, changes=None, occurred_at=None):
    """Append one project-level business event to the home feed.

    Args:
        project: The project affected by the action.
        actor: The authenticated user who performed the action.
        action: Machine-readable action such as ``created`` or ``updated``.
        changes: Optional list of ``field``/``old_value``/``new_value`` dicts.
        occurred_at: Event time; defaults to the current moment.

    Returns:
        The created ``HomeActivityEvent``.
    """
    display_name = actor_display(actor)
    if display_name:
        summary = f"{display_name} {action} project {project.name}"
    else:
        summary = f"{action} project {project.name}"
    return HomeActivityEvent.objects.create(
        workspace=project.workspace,
        actor=actor,
        entity_type=HomeActivityEvent.EntityType.PROJECT,
        entity_id=project.id,
        entity_name=project.name,
        project_id=project.id,
        action=action,
        summary=summary,
        changes=changes or [],
        occurred_at=occurred_at or timezone.now(),
    )


def resolve_project_change_values(field, old_value, new_value):
    """Resolve user identifiers into readable project-change values.

    Args:
        field: Project field being changed.
        old_value: Value before the change (user id or scalar).
        new_value: Value after the change (user id or scalar).

    Returns:
        A pair of display-friendly old/new values.
    """
    if field == "network":
        labels = {"0": "私密", "2": "公开"}
        return labels.get(str(old_value)), labels.get(str(new_value))
    if field == "guest_view_all_features":
        labels = {"True": "开启", "False": "关闭"}
        return labels.get(str(old_value)), labels.get(str(new_value))
    if field != "project_lead":
        return str(old_value or "") or None, str(new_value or "")

    user_ids = {str(value) for value in (old_value, new_value) if value}
    users = {str(user.id): actor_display(user) for user in User.objects.filter(id__in=user_ids)}
    return users.get(str(old_value or ""), None), users.get(str(new_value or ""), None)
