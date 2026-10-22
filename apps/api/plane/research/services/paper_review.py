# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""State machine and append-only evidence for research paper reviews."""

from django.db import IntegrityError, transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from plane.db.models import (
    FileAsset,
    OrgUnitMember,
    ProjectMember,
    WorkspaceMember,
    ResearchChain,
    ResearchChainEvent,
    ResearchChainNode,
    ResearchOutcome,
    ResearchPaperReview,
    ResearchPaperReviewVersion,
    User,
)
from plane.research.services.chain_tasks import (
    chain_manager,
    chain_writer,
    review_only_actor,
)
from plane.research.services.idempotency import payload_hash
from plane.research.utils.acl import org_unit_ancestry
from plane.research.utils.org import READABLE_WORKSPACE_ROLES, active_membership_q
from plane.research.utils.audit import ResearchAuditAction, ResearchResourceType, record_audit_event
from plane.research.utils.collaboration_notifications import (
    notify_paper_accepted,
    notify_paper_returned,
    notify_paper_version_submitted,
)
from plane.research.utils.files import inspect_uploaded_asset, validate_attachment
from plane.research.utils.roles import is_research_admin
from plane.research.utils.settings import get_workspace_research_settings
from plane.settings.storage import S3Storage

PAPER_ASSET_ENTITY = "RESEARCH_PAPER_REVIEW_VERSION"
PAPER_FILE_EXTENSIONS = (".pdf", ".md", ".markdown")


class PaperReviewPermissionError(Exception):
    """Raised when an actor cannot execute a paper review action."""


class PaperReviewValidationError(Exception):
    """Raised when a paper review payload violates the API contract."""

    def __init__(self, message, error_code="research_chain_invalid"):
        super().__init__(message)
        self.error_code = error_code


class PaperReviewStateError(Exception):
    """Raised when a paper review transition is unavailable."""


class PaperReviewConflictError(Exception):
    """Raised when an idempotency key is reused with another payload."""


def actor_can_submit_paper(workspace, review, actor) -> bool:
    """Return whether the actor may submit the next immutable version.

    Args:
        workspace: Workspace that owns the review.
        review: Paper review being written.
        actor: User requesting the submission.

    Returns:
        True when the actor is the review owner or a chain writer.
    """
    if actor is None or not getattr(actor, "is_authenticated", False):
        return False
    return review.owner_id == actor.id or chain_writer(workspace, actor, review.chain)


def actor_can_review_paper(workspace, review, actor) -> bool:
    """Return whether the actor may issue a scientific paper-review decision.

    Research administrators hold review authority even when they are not the
    named final reviewer and have no organisation assignment.

    Args:
        workspace: Workspace that owns the review.
        review: Paper review awaiting a decision.
        actor: User requesting the decision.

    Returns:
        True for a research administrator, the explicit final reviewer, or a
        research-scope reviewer.
    """
    if actor is None or not getattr(actor, "is_authenticated", False):
        return False
    if review.owner_id == actor.id:
        return False
    if is_research_admin(actor, workspace.id):
        return True
    return review.final_reviewer_id == actor.id or review_only_actor(workspace, actor, review.chain)


def actor_can_withdraw_paper(workspace, review, actor) -> bool:
    """Return whether the actor may withdraw a review before acceptance.

    Args:
        workspace: Workspace that owns the review.
        review: Paper review being withdrawn.
        actor: User requesting withdrawal.

    Returns:
        True for the review owner or a chain manager.
    """
    if actor is None or not getattr(actor, "is_authenticated", False):
        return False
    return review.owner_id == actor.id or chain_manager(workspace, actor, review.chain)


def paper_file_error(file_name, content_type, size_bytes, limits):
    """Validate the narrow PDF/Markdown paper file contract.

    Args:
        file_name: Display name supplied by the presign request.
        content_type: Declared object MIME type.
        size_bytes: Declared object size.
        limits: Effective workspace file limits.

    Returns:
        A research error code, or ``None`` when the file is acceptable.
    """
    normalized_name = str(file_name or "").strip().lower()
    if not normalized_name.endswith(PAPER_FILE_EXTENSIONS):
        return "file_type_not_allowed"
    return validate_attachment(
        file_name=file_name,
        content_type=content_type,
        size_bytes=size_bytes,
        limits=limits,
    )


def _request_id(payload) -> str:
    """Extract and bound-check a paper review idempotency key."""
    request_id = str(payload.get("request_id") or "").strip()
    if not request_id:
        raise PaperReviewValidationError("request_id is required.")
    if len(request_id) > 128:
        raise PaperReviewValidationError("request_id must contain at most 128 characters.")
    return request_id


def _ensure_parent_writable(chain, node):
    """Reject paper writes when the chain or node is read-only."""
    if chain.status != ResearchChain.Status.ACTIVE:
        raise PaperReviewStateError("Archived or completed chains are read-only.")
    if node.status == ResearchChainNode.Status.ARCHIVED:
        raise PaperReviewStateError("Archived nodes cannot receive paper versions.")


def _paper_refs(review, version=None):
    """Build the standard paper event reference list."""
    refs = [
        {"kind": "chain", "id": str(review.chain_id)},
        {"kind": "node", "id": str(review.node_id)},
        {"kind": "paper_review", "id": str(review.id)},
    ]
    if version is not None:
        refs.append(
            {
                "kind": "paper_version",
                "id": str(version.id),
                "version_no": version.version_no,
            }
        )
    return refs


def _event_id(request_id, event_type, target_id):
    """Build a deterministic paper event id."""
    return payload_hash({"request_id": request_id, "kind": event_type, "target_id": str(target_id)})


def _write_paper_event(*, review, actor, request_id, event_type, summary, metadata, content_hash, version=None):
    """Append one immutable paper fact to the Chain timeline."""
    return ResearchChainEvent.objects.create(
        chain=review.chain,
        node=review.node,
        event_id=_event_id(request_id, event_type, version.id if version else review.id),
        request_id=request_id,
        actor=actor,
        actor_type="USER",
        source_system="PLANE",
        event_type=event_type,
        occurred_at=timezone.now(),
        refs=_paper_refs(review, version),
        summary=summary,
        content_hash=content_hash,
        metadata=metadata,
    )


def _write_paper_audit(*, review, actor, action, resource_type, resource_id, metadata, request=None):
    """Append the audit-side record for a paper mutation."""
    return record_audit_event(
        workspace=review.workspace,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        org_unit=getattr(review.chain.project.research_profile, "org_unit", None),
        actor=actor,
        metadata=metadata,
        request=request,
    )


def _replay_paper_event(review, version, request_id, event_type, content_hash):
    """Return a compatible paper action replay, if one exists."""
    existing = ResearchChainEvent.objects.filter(request_id=request_id).first()
    event_id = _event_id(request_id, event_type, version.id if version else review.id)
    if existing is None:
        existing = ResearchChainEvent.objects.filter(event_id=event_id).first()
    if existing is None:
        return None

    review_ref = next((ref for ref in existing.refs if ref.get("kind") == "paper_review"), None)
    version_ref = next((ref for ref in existing.refs if ref.get("kind") == "paper_version"), None)
    compatible = (
        existing.chain_id == review.chain_id
        and existing.node_id == review.node_id
        and review_ref is not None
        and review_ref.get("id") == str(review.id)
        and existing.event_type == event_type
        and existing.content_hash == content_hash
    )
    if version is not None:
        compatible = compatible and version_ref is not None and version_ref.get("id") == str(version.id)
    else:
        compatible = compatible and version_ref is None
    if not compatible:
        raise PaperReviewConflictError("request_id was already used with another paper action.")
    return existing


def _valid_final_reviewer(workspace, chain, user):
    """保留论文终审人原有的组织及显式协作边界。

    Args:
        workspace: 当前工作区。
        chain: 论文所属研究链。
        user: 候选终审人。

    Returns:
        有效工作区成员属于课题组织、上级组织或显式协作者时为 True。
    """
    if not WorkspaceMember.objects.filter(
        workspace=workspace, member=user, member__is_active=True,
        role__in=READABLE_WORKSPACE_ROLES, is_active=True, deleted_at__isnull=True,
    ).exists():
        return False
    if ProjectMember.objects.filter(
        project_id=chain.project_id, member=user, is_active=True, deleted_at__isnull=True,
    ).exists():
        return True
    profile = getattr(chain.project, "research_profile", None)
    if profile is None or profile.org_unit_id is None:
        return False
    unit_ids = [profile.org_unit_id, *org_unit_ancestry(profile.org_unit_id, workspace.id)]
    return OrgUnitMember.objects.filter(
        active_membership_q(timezone.localdate()), workspace=workspace,
        org_unit_id__in=unit_ids, org_unit__deleted_at__isnull=True, user=user,
    ).exists()


def _final_reviewer_from_payload(workspace, chain, actor, payload):
    """Resolve and server-validate an optional final reviewer.

    Args:
        workspace: Workspace that owns the chain.
        chain: Research chain supplying the assignable-user boundary.
        actor: User opening the review.
        payload: Validated JSON payload containing ``final_reviewer``.

    Returns:
        The resolved active reviewer, or ``None`` when omitted.
    """
    value = payload.get("final_reviewer")
    if value in (None, ""):
        return None
    user_id = value.id if hasattr(value, "id") else value
    reviewer = User.objects.filter(pk=user_id, is_active=True).first()
    if reviewer is None or reviewer.id == actor.id or not _valid_final_reviewer(workspace, chain, reviewer):
        raise PaperReviewPermissionError("final_reviewer is outside the chain's reviewer candidate boundary.")
    return reviewer


def _outcome_from_payload(workspace, chain, payload):
    """Resolve an optional outcome attached to the same research project."""
    value = payload.get("outcome")
    if value in (None, ""):
        return None
    outcome_id = value.id if hasattr(value, "id") else value
    outcome = ResearchOutcome.objects.select_related("workspace").filter(pk=outcome_id).first()
    if outcome is None or outcome.workspace_id != workspace.id or outcome.project_id != chain.project_id:
        raise PaperReviewValidationError("outcome must belong to the review chain's project.")
    return outcome


def create_paper_review(*, workspace, chain, node, actor, payload, request=None):
    """Create an idempotent paper review on a PAPER_WRITING node.

    Args:
        workspace: Workspace that owns the review.
        chain: Active research chain owning the node.
        node: Node that must have type ``PAPER_WRITING``.
        actor: User opening the review and becoming its owner.
        payload: Validated JSON payload with an idempotency key.
        request: Optional HTTP request used for audit client metadata.

    Returns:
        A ``(review, created)`` tuple; replayed requests return ``False``.
    """
    request_id = _request_id(payload)
    digest = payload_hash(payload)
    if not chain_writer(workspace, actor, chain):
        raise PaperReviewPermissionError("Only chain writers can open paper reviews.")
    existing = _replay_review_for_context(workspace, chain, node, request_id, digest)
    if existing is not None:
        return existing, False

    outcome = _outcome_from_payload(workspace, chain, payload)
    final_reviewer = _final_reviewer_from_payload(workspace, chain, actor, payload)
    due_at = payload.get("due_at")
    if due_at in (None, ""):
        due_at = None
    elif not hasattr(due_at, "tzinfo"):
        due_at = parse_datetime(str(due_at))
    if due_at is not None and due_at.tzinfo is None:
        due_at = timezone.make_aware(due_at)
    if due_at is None and payload.get("due_at") not in (None, ""):
        raise PaperReviewValidationError("due_at must be an ISO-8601 datetime.")

    try:
        with transaction.atomic():
            locked_chain = ResearchChain.objects.select_for_update().get(pk=chain.pk)
            locked_node = ResearchChainNode.objects.select_for_update().get(pk=node.pk)
            _ensure_parent_writable(locked_chain, locked_node)
            if not chain_writer(workspace, actor, locked_chain):
                raise PaperReviewPermissionError("Only chain writers can open paper reviews.")
            if locked_node.node_type != "PAPER_WRITING":
                raise PaperReviewValidationError("Paper review must attach to a PAPER_WRITING node.")
            if (
                outcome is not None
                and ResearchPaperReview.objects.filter(
                    node=locked_node,
                    outcome_id=outcome.id,
                    status__in=(
                        ResearchPaperReview.Status.OPEN,
                        ResearchPaperReview.Status.WAITING_REVIEW,
                        ResearchPaperReview.Status.NEEDS_REVISION,
                        ResearchPaperReview.Status.ACCEPTED,
                    ),
                ).exists()
            ):
                raise PaperReviewStateError("This outcome already has an active review on the node.")

            review = ResearchPaperReview.objects.create(
                workspace=workspace,
                chain=locked_chain,
                node=locked_node,
                outcome=outcome,
                owner=actor,
                status=ResearchPaperReview.Status.OPEN,
                final_reviewer=final_reviewer,
                due_at=due_at,
                request_id=request_id,
                payload_hash=digest,
                metadata={
                    "owner_id": str(actor.id),
                    "final_reviewer_id": str(final_reviewer.id) if final_reviewer else None,
                },
                created_by=actor,
                updated_by=actor,
            )
            _write_paper_event(
                review=review,
                actor=actor,
                request_id=request_id,
                event_type="PAPER_REVIEW_OPENED",
                summary=f"Opened paper review on {locked_node.title}",
                metadata={"status": review.status},
                content_hash=digest,
            )
            _write_paper_audit(
                review=review,
                actor=actor,
                action=ResearchAuditAction.PAPER_REVIEW_CREATE,
                resource_type=ResearchResourceType.RESEARCH_PAPER_REVIEW,
                resource_id=review.id,
                metadata={"node": str(locked_node.id), "status": review.status},
                request=request,
            )
        return review, True
    except IntegrityError:
        existing = _replay_review_for_context(workspace, chain, node, request_id, digest)
        if existing is not None:
            return existing, False
        raise PaperReviewConflictError("request_id was already used.") from None


def _replay_review_for_context(workspace, chain, node, request_id, content_hash):
    """Return a review replay only when its context and payload match."""
    existing = ResearchPaperReview.objects.filter(request_id=request_id).first()
    if existing is None:
        return None
    if (
        existing.workspace_id != workspace.id
        or existing.chain_id != chain.id
        or existing.node_id != node.id
        or existing.payload_hash != content_hash
    ):
        raise PaperReviewConflictError("request_id was already used with another paper review.")
    return existing


def _resolve_version_asset(*, review, actor, payload, request):
    """Validate and confirm the S3-backed asset used by a paper version."""
    asset_id = payload.get("asset_id")
    asset = FileAsset.objects.filter(
        pk=asset_id,
        workspace_id=review.workspace_id,
        entity_type=PAPER_ASSET_ENTITY,
        entity_identifier=str(review.id),
    ).first()
    if asset is None:
        raise PaperReviewValidationError("The uploaded paper asset could not be found.", "report_attachment_not_found")
    if asset.created_by_id != actor.id:
        raise PaperReviewValidationError(
            "The uploaded paper asset was not created by the actor.",
            "report_attachment_not_found",
        )

    file_name = str(asset.attributes.get("name") or asset.asset.name or "").strip()
    limits = get_workspace_research_settings(review.workspace)
    if not asset.is_uploaded:
        try:
            error_code, metadata = inspect_uploaded_asset(S3Storage(request=request), asset, limits)
        except Exception:
            error_code, metadata = "attachment_not_found", None
        if error_code:
            raise PaperReviewValidationError("This paper file is not allowed.", error_code)
        asset.size = metadata["ContentLength"]
        asset.storage_metadata = metadata
        asset.is_uploaded = True
        asset.attributes = {
            **asset.attributes,
            "type": metadata["ContentType"],
            "size": asset.size,
        }
        asset.save(update_fields=["size", "storage_metadata", "is_uploaded", "attributes", "updated_at"])

    content_type = str(asset.attributes.get("type") or "")
    file_size = int(asset.size or asset.attributes.get("size") or 0)
    error_code = paper_file_error(file_name, content_type, file_size, limits)
    if error_code:
        raise PaperReviewValidationError("This paper file is not allowed.", error_code)
    content_hash = str(asset.attributes.get("sha256") or "")
    if len(content_hash) != 64 or any(character not in "0123456789abcdefABCDEF" for character in content_hash):
        raise PaperReviewValidationError("sha256 is required for a paper version.")
    return asset, file_name, content_type, file_size, content_hash


def submit_paper_version(*, review, actor, payload, request=None):
    """Submit one immutable S3-backed version for review.

    Args:
        review: Paper review receiving the version.
        actor: Review owner or chain writer submitting the file.
        payload: JSON payload containing asset ID and change summary.
        request: Optional HTTP request used for storage and audit metadata.

    Returns:
        A ``(version, created)`` tuple; replayed requests return ``False``.
    """
    request_id = _request_id(payload)
    digest = payload_hash(payload)
    change_summary = str(payload.get("change_summary") or "").strip()
    if not change_summary:
        raise PaperReviewValidationError("change_summary is required.")

    existing = ResearchPaperReviewVersion.objects.filter(request_id=request_id).select_related("review").first()
    if existing is not None:
        if existing.review_id != review.id or existing.content_hash != _version_payload_hash(existing, payload):
            raise PaperReviewConflictError("request_id was already used with another paper version.")
        return existing, False

    if not actor_can_submit_paper(review.workspace, review, actor):
        raise PaperReviewPermissionError("Only the review owner or chain writers can submit versions.")
    asset, file_name, content_type, file_size, sha256 = _resolve_version_asset(
        review=review,
        actor=actor,
        payload=payload,
        request=request,
    )

    version_hash = payload_hash(
        {
            "review_id": str(review.id),
            "asset_id": str(asset.id),
            "file_name": file_name,
            "file_size": file_size,
            "change_summary": change_summary,
            "request_id": request_id,
        }
    )
    try:
        with transaction.atomic():
            locked_chain = ResearchChain.objects.select_for_update().get(pk=review.chain_id)
            locked_node = ResearchChainNode.objects.select_for_update().get(pk=review.node_id)
            locked_review = ResearchPaperReview.objects.select_for_update().get(pk=review.pk)
            _ensure_parent_writable(locked_chain, locked_node)
            if not actor_can_submit_paper(locked_review.workspace, locked_review, actor):
                raise PaperReviewPermissionError("Only the review owner or chain writers can submit versions.")
            if locked_review.status not in (
                ResearchPaperReview.Status.OPEN,
                ResearchPaperReview.Status.NEEDS_REVISION,
            ):
                raise PaperReviewStateError(f"SUBMIT is not allowed from {locked_review.status}.")

            version_no = locked_review.current_version_no + 1
            version = ResearchPaperReviewVersion.objects.create(
                review=locked_review,
                version_no=version_no,
                asset=asset,
                file_name=file_name,
                content_type=content_type,
                file_size=file_size,
                change_summary=change_summary,
                status=ResearchPaperReviewVersion.Status.SUBMITTED,
                submitted_by=actor,
                submitted_at=timezone.now(),
                content_hash=version_hash,
                request_id=request_id,
            )
            locked_review.current_version_no = version_no
            locked_review.status = ResearchPaperReview.Status.WAITING_REVIEW
            locked_review.updated_by = actor
            locked_review.save(update_fields=["current_version_no", "status", "updated_by", "updated_at"])
            _write_paper_event(
                review=locked_review,
                version=version,
                actor=actor,
                request_id=request_id,
                event_type="PAPER_VERSION_SUBMITTED",
                summary=f"Submitted paper version {version_no}",
                metadata={
                    "status": locked_review.status,
                    "version_no": version_no,
                    "change_summary": change_summary[:500],
                    "sha256": sha256,
                },
                content_hash=digest,
            )
            _write_paper_audit(
                review=locked_review,
                actor=actor,
                action=ResearchAuditAction.PAPER_VERSION_SUBMIT,
                resource_type=ResearchResourceType.RESEARCH_PAPER_REVIEW_VERSION,
                resource_id=version.id,
                metadata={"version_no": version_no, "file_name": file_name},
                request=request,
            )
            notify_paper_version_submitted(locked_review, actor)
        return version, True
    except IntegrityError:
        existing = ResearchPaperReviewVersion.objects.filter(request_id=request_id).first()
        if existing is not None and existing.review_id == review.id:
            return existing, False
        raise PaperReviewConflictError("request_id was already used.") from None


def _version_payload_hash(version, payload):
    """Recompute the stable payload hash stored on a version."""
    return payload_hash(
        {
            "review_id": str(version.review_id),
            "asset_id": str(version.asset_id),
            "file_name": version.file_name,
            "file_size": version.file_size,
            "change_summary": version.change_summary,
            "request_id": str(payload.get("request_id") or version.request_id),
        }
    )


def _run_version_decision(
    *,
    review,
    version,
    actor,
    comment,
    request_id,
    content_hash,
    action,
    event_type,
    metadata,
    request,
):
    """Lock and execute one latest-version decision."""
    if not actor_can_review_paper(review.workspace, review, actor):
        raise PaperReviewPermissionError("Only scientific reviewers can decide this paper version.")
    comment = str(comment or "").strip()
    if event_type == "PAPER_REVIEW_RETURNED" and not comment:
        raise PaperReviewValidationError("comment is required.")

    with transaction.atomic():
        locked_chain = ResearchChain.objects.select_for_update().get(pk=review.chain_id)
        locked_node = ResearchChainNode.objects.select_for_update().get(pk=review.node_id)
        locked_review = ResearchPaperReview.objects.select_for_update().get(pk=review.pk)
        locked_version = ResearchPaperReviewVersion.objects.select_for_update().get(pk=version.pk)
        _ensure_parent_writable(locked_chain, locked_node)
        if not actor_can_review_paper(locked_review.workspace, locked_review, actor):
            raise PaperReviewPermissionError("Only scientific reviewers can decide this paper version.")
        if locked_version.version_no != locked_review.current_version_no:
            raise PaperReviewStateError("Only the latest paper version can be decided.")
        if (
            _replay_paper_event(
                locked_review,
                locked_version,
                request_id,
                event_type,
                content_hash,
            )
            is not None
        ):
            return locked_review, locked_version, False
        action(locked_review)
        event_metadata = {
            **metadata,
            "comment": comment[:500],
            "status": locked_review.status,
            "version_no": locked_version.version_no,
        }
        _write_paper_event(
            review=locked_review,
            version=locked_version,
            actor=actor,
            request_id=request_id,
            event_type=event_type,
            summary=f"{event_type}: version {locked_version.version_no}",
            metadata=event_metadata,
            content_hash=content_hash,
        )
        _write_paper_audit(
            review=locked_review,
            actor=actor,
            action={
                "PAPER_REVIEW_RETURNED": ResearchAuditAction.PAPER_REVIEW_RETURN,
                "PAPER_REVIEW_ACCEPTED": ResearchAuditAction.PAPER_REVIEW_ACCEPT,
            }[event_type],
            resource_type=ResearchResourceType.RESEARCH_PAPER_REVIEW,
            resource_id=locked_review.id,
            metadata=event_metadata,
            request=request,
        )
        if event_type == "PAPER_REVIEW_RETURNED":
            notify_paper_returned(locked_review, actor, comment)
        else:
            notify_paper_accepted(locked_review, actor, comment)
        return locked_review, locked_version, True


def return_paper_version(*, review, version, actor, comment, request_id, content_hash="", request=None):
    """Return the latest submitted version for revision.

    Args:
        review: Paper review awaiting a decision.
        version: Latest immutable version being returned.
        actor: Scientific reviewer making the decision.
        comment: Required revision comment stored in the Chain Event.
        request_id: Idempotency key supplied by the caller.
        content_hash: Stable decision payload hash used for replay.
        request: Optional HTTP request used for audit client metadata.

    Returns:
        A ``(review, version, changed)`` tuple.
    """
    request_id = _request_id({"request_id": request_id})

    def action(locked_review):
        if locked_review.status != ResearchPaperReview.Status.WAITING_REVIEW:
            raise PaperReviewStateError(f"RETURN is not allowed from {locked_review.status}.")
        locked_review.status = ResearchPaperReview.Status.NEEDS_REVISION
        locked_review.updated_by = actor
        locked_review.save(update_fields=["status", "updated_by", "updated_at"])

    return _run_version_decision(
        review=review,
        version=version,
        actor=actor,
        comment=comment,
        request_id=request_id,
        content_hash=content_hash,
        action=action,
        event_type="PAPER_REVIEW_RETURNED",
        metadata={},
        request=request,
    )


def accept_paper_version(*, review, version, actor, comment="", request_id=None, content_hash="", request=None):
    """Accept the latest submitted version as the final paper version.

    Args:
        review: Paper review awaiting final confirmation.
        version: Latest immutable version being accepted.
        actor: Final reviewer or scientific reviewer.
        comment: Optional acceptance comment stored in the Chain Event.
        request_id: Idempotency key supplied by the caller.
        content_hash: Stable decision payload hash used for replay.
        request: Optional HTTP request used for audit client metadata.

    Returns:
        A ``(review, version, changed)`` tuple.
    """
    request_id = _request_id({"request_id": request_id})

    def action(locked_review):
        if locked_review.status != ResearchPaperReview.Status.WAITING_REVIEW:
            raise PaperReviewStateError(f"ACCEPT is not allowed from {locked_review.status}.")
        locked_review.status = ResearchPaperReview.Status.ACCEPTED
        locked_review.updated_by = actor
        locked_review.save(update_fields=["status", "updated_by", "updated_at"])

    return _run_version_decision(
        review=review,
        version=version,
        actor=actor,
        comment=comment,
        request_id=request_id,
        content_hash=content_hash,
        action=action,
        event_type="PAPER_REVIEW_ACCEPTED",
        metadata={},
        request=request,
    )


def withdraw_paper_review(*, review, actor, reason, request_id, content_hash="", request=None):
    """Withdraw a review before it has been accepted.

    Args:
        review: Paper review being withdrawn.
        actor: Review owner or chain manager.
        reason: Required withdrawal reason stored in the Chain Event.
        request_id: Idempotency key supplied by the caller.
        content_hash: Stable withdrawal payload hash used for replay.
        request: Optional HTTP request used for audit client metadata.

    Returns:
        A ``(review, changed)`` tuple.
    """
    request_id = _request_id({"request_id": request_id})
    reason = str(reason or "").strip()
    if not reason:
        raise PaperReviewValidationError("reason is required.")
    if not actor_can_withdraw_paper(review.workspace, review, actor):
        raise PaperReviewPermissionError("Only the review owner or chain managers can withdraw a review.")

    with transaction.atomic():
        locked_chain = ResearchChain.objects.select_for_update().get(pk=review.chain_id)
        locked_node = ResearchChainNode.objects.select_for_update().get(pk=review.node_id)
        locked_review = ResearchPaperReview.objects.select_for_update().get(pk=review.pk)
        _ensure_parent_writable(locked_chain, locked_node)
        if not actor_can_withdraw_paper(locked_review.workspace, locked_review, actor):
            raise PaperReviewPermissionError("Only the review owner or chain managers can withdraw a review.")
        if (
            _replay_paper_event(
                locked_review,
                None,
                request_id,
                "PAPER_REVIEW_WITHDRAWN",
                content_hash,
            )
            is not None
        ):
            return locked_review, False
        if locked_review.status in (
            ResearchPaperReview.Status.ACCEPTED,
            ResearchPaperReview.Status.WITHDRAWN,
        ):
            raise PaperReviewStateError(f"WITHDRAW is not allowed from {locked_review.status}.")
        locked_review.status = ResearchPaperReview.Status.WITHDRAWN
        locked_review.updated_by = actor
        locked_review.save(update_fields=["status", "updated_by", "updated_at"])
        metadata = {"reason": reason[:500], "status": locked_review.status}
        _write_paper_event(
            review=locked_review,
            actor=actor,
            request_id=request_id,
            event_type="PAPER_REVIEW_WITHDRAWN",
            summary=f"Withdrew paper review: {reason[:120]}",
            metadata=metadata,
            content_hash=content_hash,
        )
        _write_paper_audit(
            review=locked_review,
            actor=actor,
            action=ResearchAuditAction.PAPER_REVIEW_WITHDRAW,
            resource_type=ResearchResourceType.RESEARCH_PAPER_REVIEW,
            resource_id=locked_review.id,
            metadata=metadata,
            request=request,
        )
        return locked_review, True
