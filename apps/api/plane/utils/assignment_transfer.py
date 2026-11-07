"""Secure assignment-transfer links shared by notification emails and the confirmation API."""

from datetime import timedelta
from urllib.parse import urlencode
from uuid import UUID

from django.core import signing
from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from plane.db.models import Issue, ResearchChainNodeTask, User
from plane.utils.administrative_projects import (
    assignable_project_member_ids,
    research_project_ids,
)
from plane.utils.preferred_collaborators import order_by_preferred_collaborators

ASSIGNMENT_TRANSFER_ACTION = "assignment_transfer"
ASSIGNMENT_TRANSFER_SALT = "plane.email.assignment-transfer.v1"
ASSIGNMENT_TRANSFER_TOKEN_LIFETIME = timedelta(days=7)
ASSIGNMENT_TRANSFER_CANDIDATE_LIMIT = 8
ISSUE_ENTITY = "issue"
RESEARCH_TASK_ENTITY = "research_chain_task"


class AssignmentTransferError(Exception):
    """Raised when an email assignment-transfer request cannot be executed."""

    def __init__(self, code, message, status=400, route=""):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.route = route


def build_assignment_transfer_token(entity_type, entity_id, receiver_id, current_owner_id):
    """Build a signed, expiring token for one assignment email recipient.

    Args:
        entity_type: Either ``issue`` or ``research_chain_task``.
        entity_id: Work item identifier embedded in the link.
        receiver_id: User who received the assignment email.
        current_owner_id: Responsible user when the email was rendered.

    Returns:
        A signed opaque token string.
    """
    if entity_type not in {ISSUE_ENTITY, RESEARCH_TASK_ENTITY}:
        raise ValueError("Unsupported assignment-transfer entity type.")
    payload = {
        "action": ASSIGNMENT_TRANSFER_ACTION,
        "entity_type": entity_type,
        "entity_id": str(entity_id),
        "receiver_id": str(receiver_id),
        "current_owner_id": str(current_owner_id),
        "expires_at": (timezone.now() + ASSIGNMENT_TRANSFER_TOKEN_LIFETIME).isoformat(),
    }
    return signing.dumps(payload, salt=ASSIGNMENT_TRANSFER_SALT)


def load_assignment_transfer_token(token):
    """Verify and decode an assignment-transfer token.

    Args:
        token: Opaque token taken from the email link.

    Returns:
        The validated token payload.

    Raises:
        AssignmentTransferError: When the token is malformed, tampered, or expired.
    """
    try:
        payload = signing.loads(
            token,
            salt=ASSIGNMENT_TRANSFER_SALT,
            max_age=int(ASSIGNMENT_TRANSFER_TOKEN_LIFETIME.total_seconds()),
        )
    except signing.SignatureExpired as exc:
        raise AssignmentTransferError("assignment_transfer_expired", "转派链接已过期。", 410) from exc
    except (signing.BadSignature, TypeError, ValueError) as exc:
        raise AssignmentTransferError("assignment_transfer_invalid", "转派链接无效。", 400) from exc

    expected = {"action", "entity_type", "entity_id", "receiver_id", "current_owner_id", "expires_at"}
    if not isinstance(payload, dict) or set(payload) != expected:
        raise AssignmentTransferError("assignment_transfer_invalid", "转派链接无效。", 400)
    if payload["action"] != ASSIGNMENT_TRANSFER_ACTION:
        raise AssignmentTransferError("assignment_transfer_invalid", "转派链接无效。", 400)
    expires_at = parse_datetime(str(payload["expires_at"]))
    if expires_at is None or timezone.is_naive(expires_at) or expires_at <= timezone.now():
        raise AssignmentTransferError("assignment_transfer_expired", "转派链接已过期。", 410)
    return payload


def _user_payload(user):
    return {"id": str(user.id), "display_name": user.display_name or user.email}


def _sorted_candidates(users, current_owner_id):
    return sorted(
        (user for user in users if user.id != current_owner_id and user.is_active),
        key=lambda user: ((user.display_name or user.email).lower(), str(user.id)),
    )


def assignment_transfer_candidates(entity_type, entity):
    """Return the ordered server-validated transfer candidates for one work item.

    Args:
        entity_type: Either ``issue`` or ``research_chain_task``.
        entity: Loaded Issue or ResearchChainNodeTask instance.

    Returns:
        A list of active candidate User instances, excluding the current owner.
    """
    if entity_type == ISSUE_ENTITY:
        users = User.objects.filter(id__in=assignable_project_member_ids(entity.project))
    else:
        from plane.research.services.chain_tasks import assignable_chain_members

        users = User.objects.filter(
            id__in=assignable_chain_members(entity.workspace, entity.chain).values("member_id")
        )
    return _sorted_candidates(users, assignment_transfer_owner_id(entity_type, entity))


def assignment_transfer_owner_id(entity_type, entity):
    """Return the current responsible-user identifier for a transfer entity."""
    if entity_type == ISSUE_ENTITY:
        return entity.issue_assignee.values_list("assignee_id", flat=True).first()
    return entity.assignee_id


def assignment_transfer_route(entity_type, entity):
    """Return the native server-relative work-item route used by email links."""
    workspace_slug = entity.workspace.slug
    if entity_type == ISSUE_ENTITY:
        return (
            f"/{workspace_slug}/projects/{entity.project_id}/issues/{entity.id}"
        )
    return (
        f"/{workspace_slug}/research/chains/{entity.chain_id}"
        f"?node={entity.node_id}&task={entity.id}"
    )


def assignment_transfer_email_context(entity_type, entity, receiver, base_url):
    """Build the transfer action block rendered inside an assignment email.

    Args:
        entity_type: Either ``issue`` or ``research_chain_task``.
        entity: Work item whose owner may transfer responsibility.
        receiver: Email recipient and current responsible user.
        base_url: Absolute site base URL.

    Returns:
        A template context dictionary, or an empty dictionary when unavailable.
        Candidate ordering prioritizes the receiver's preferred collaborators
        before the display cap is applied.
    """
    owner_id = assignment_transfer_owner_id(entity_type, entity)
    if owner_id is None or str(owner_id) != str(receiver.id):
        return {}
    candidates = assignment_transfer_candidates(entity_type, entity)
    if not candidates:
        return {}
    candidates = order_by_preferred_collaborators(
        candidates,
        lambda candidate: str(candidate.id),
        receiver.id,
    )
    token = build_assignment_transfer_token(entity_type, entity.id, receiver.id, owner_id)
    action_url = f"{base_url.rstrip('/')}/email-actions/assignment-transfer/"
    native_route = assignment_transfer_route(entity_type, entity)
    separator = "&" if "?" in native_route else "?"
    items = []
    for candidate in candidates[:ASSIGNMENT_TRANSFER_CANDIDATE_LIMIT]:
        query = urlencode({"token": token, "candidate": str(candidate.id)})
        items.append(
            {
                **_user_payload(candidate),
                "url": f"{action_url}?{query}",
            }
        )
    return {
        "enabled": True,
        "candidates": items,
        "has_more_candidates": len(candidates) > ASSIGNMENT_TRANSFER_CANDIDATE_LIMIT,
        "native_url": f"{base_url.rstrip('/')}{native_route}{separator}email_transfer=1",
    }


def _load_transfer_entity(payload):
    entity_type = payload["entity_type"]
    try:
        if entity_type == ISSUE_ENTITY:
            entity = (
                Issue.objects.select_related("project", "project__workspace", "workspace")
                .filter(
                    pk=payload["entity_id"],
                    deleted_at__isnull=True,
                    archived_at__isnull=True,
                    project__archived_at__isnull=True,
                )
                .exclude(project_id__in=research_project_ids())
                .first()
            )
        else:
            entity = ResearchChainNodeTask.objects.select_related(
                "workspace", "chain", "chain__project", "node"
            ).filter(pk=payload["entity_id"]).first()
    except (Issue.DoesNotExist, ResearchChainNodeTask.DoesNotExist, ValueError):
        entity = None
    if entity is None:
        raise AssignmentTransferError("assignment_transfer_entity_unavailable", "工作项不存在或已不可访问。", 404)
    return entity_type, entity


def _candidate_is_valid(entity_type, entity, candidate):
    if entity_type == ISSUE_ENTITY:
        return assignable_project_member_ids(entity.project).filter(id=candidate.id).exists()
    from plane.research.services.chain_tasks import validate_assignable_user

    return validate_assignable_user(entity.workspace, entity.chain, candidate.id)


def assignment_transfer_preview(token, candidate_id, actor):
    """Validate an email transfer request and return its confirmation snapshot.

    Args:
        token: Signed opaque token from the email link.
        candidate_id: Candidate selected by the email recipient.
        actor: Authenticated user opening the confirmation page.

    Returns:
        A JSON-serializable confirmation payload.
    """
    payload = load_assignment_transfer_token(token)
    entity_type, entity = _load_transfer_entity(payload)
    if str(actor.id) != str(payload["receiver_id"]):
        raise AssignmentTransferError("assignment_transfer_forbidden", "只有邮件接收人可以执行此转派。", 403)

    owner_id = assignment_transfer_owner_id(entity_type, entity)
    candidate = None
    try:
        candidate_uuid = UUID(str(candidate_id))
    except (TypeError, ValueError):
        candidate_uuid = None
    if candidate_uuid is not None:
        candidate = User.objects.filter(pk=candidate_uuid, is_active=True).first()
    route = assignment_transfer_route(entity_type, entity)
    common = {
        "entity_type": "administrative_work_item"
        if entity_type == ISSUE_ENTITY
        else "research_work_item",
        "title": entity.name if entity_type == ISSUE_ENTITY else entity.title,
        "workspace_slug": entity.workspace.slug,
        "route": route,
        "expires_at": payload["expires_at"],
    }
    if owner_id is not None and candidate is not None and str(owner_id) == str(candidate.id):
        return common | {
            "status": "already_completed",
            "current_assignee": _user_payload(candidate),
            "candidate": _user_payload(candidate),
        }
    if str(owner_id) != str(payload["receiver_id"]):
        raise AssignmentTransferError(
            "assignment_changed", "负责人已变化，请到工作项详情页处理。", 409, route
        )
    if candidate is None or not _candidate_is_valid(entity_type, entity, candidate):
        raise AssignmentTransferError(
            "assignment_candidate_invalid", "候选负责人已失效，请在原生网页重新选择。", 422, route
        )
    owner = User.objects.filter(pk=owner_id, is_active=True).first()
    if owner is None:
        raise AssignmentTransferError("assignment_changed", "负责人已变化。", 409, route)
    return common | {
        "status": "ready",
        "current_assignee": _user_payload(owner),
        "candidate": _user_payload(candidate),
    }


def execute_issue_assignment_transfer(*, issue, actor, candidate, request=None):
    """Transfer an administrative work item through the native activity pipeline.

    Args:
        issue: Administrative Issue whose current owner is the actor.
        actor: Current owner and authenticated email recipient.
        candidate: Server-validated next owner.
        request: Confirmation API request used for origin metadata.

    Returns:
        ``True`` when this call changed the owner, or ``False`` when idempotently complete.
    """
    import json

    from plane.bgtasks.webhook_task import model_activity
    from plane.utils.issue_mutations import enqueue_task_on_commit, queue_issue_activity
    from plane.utils.work_item_assignment import replace_issue_assignee

    with transaction.atomic():
        locked_issue = (
            Issue.objects.select_for_update()
            .select_related("project", "project__workspace", "workspace")
            .get(pk=issue.pk, deleted_at__isnull=True, archived_at__isnull=True)
        )
        current_owner_id = assignment_transfer_owner_id(ISSUE_ENTITY, locked_issue)
        if current_owner_id == candidate.id:
            return False
        if current_owner_id != actor.id:
            raise AssignmentTransferError(
                "assignment_changed", "负责人已变化，请到工作项详情页处理。", 409
            )
        if not _candidate_is_valid(ISSUE_ENTITY, locked_issue, candidate):
            raise AssignmentTransferError(
                "assignment_candidate_invalid", "候选负责人已失效，请在原生网页重新选择。", 422
            )

        replace_issue_assignee(locked_issue, candidate.id, actor=actor)
        locked_issue.updated_by = actor
        locked_issue.save(update_fields=["updated_by", "updated_at"])
        requested_data = {
            "assignee_ids": [str(candidate.id)],
            "email_assignment_transfer": True,
        }
        current_instance = {"assignee_ids": [str(current_owner_id)]}
        queue_issue_activity(
            type="issue.activity.updated",
            requested_data=json.dumps(requested_data),
            current_instance=json.dumps(current_instance),
            actor_id=str(actor.id),
            issue_id=str(locked_issue.id),
            project_id=str(locked_issue.project_id),
            epoch=int(timezone.now().timestamp()),
            notification=True,
            email_assignment_transfer=True,
        )
        enqueue_task_on_commit(
            model_activity,
            model_name="issue",
            model_id=str(locked_issue.id),
            requested_data=requested_data,
            current_instance=current_instance,
            actor_id=actor.pk,
            slug=locked_issue.workspace.slug,
        )
    return True
