"""Idempotent control-plane operations for StudyWorkspace resources."""

from dataclasses import dataclass

from django.db import transaction

from plane.db.models import ResearchChain, StudyWorkspace, WorkspaceOperation, WorkspaceWorkingCopy
from plane.research.services.idempotency import payload_hash


ENSURE_OPERATION = "ENSURE_STUDY_WORKSPACE"


@dataclass(frozen=True)
class EnsureResult:
    """The resource and operation produced by an idempotent ensure call."""

    study: StudyWorkspace
    operation: WorkspaceOperation
    created: bool


class WorkspaceIdempotencyConflict(Exception):
    """Raised when one request id is replayed with a different payload."""


def control_plane_payload_hash(workspace_id, kind, payload, expected_head=""):
    """Create a stable operation digest scoped to one workspace and intent.

    Args:
        workspace_id: Workspace that owns the operation.
        kind: Stable control-plane operation kind.
        payload: JSON-serializable caller payload.
        expected_head: Optional Git head expected by the caller.

    Returns:
        A 64-character SHA-256 digest.
    """
    return payload_hash(
        {
            "workspace_id": str(workspace_id),
            "kind": kind,
            "payload": payload,
            "expected_head": expected_head,
        }
    )


def _replayed_operation(workspace_id, request_id, digest, kind):
    """Return an existing operation only when its idempotency key matches.

    Args:
        workspace_id: Workspace that owns the expected operation.
        request_id: Caller-provided idempotency key.
        digest: Stable payload digest.
        kind: Expected operation kind.

    Returns:
        The matching operation, or ``None`` when this is a new request.

    Raises:
        WorkspaceIdempotencyConflict: The key was reused with another payload or intent.
    """
    operation = WorkspaceOperation.objects.select_related("study", "working_copy").filter(request_id=request_id).first()
    if operation is None:
        return None
    if operation.workspace_id != workspace_id or operation.kind != kind or operation.payload_hash != digest:
        raise WorkspaceIdempotencyConflict
    return operation


@transaction.atomic
def ensure_study_workspace(workspace, chain, actor, request_id, payload):
    """Create or return the single active StudyWorkspace for a ResearchChain.

    Args:
        workspace: Workspace that owns the chain.
        chain: Existing ResearchChain selected by the caller.
        actor: User submitting the ensure intent.
        request_id: Stable idempotency key.
        payload: Raw JSON payload used for replay hashing.

    Returns:
        An :class:`EnsureResult` containing the resource, operation and creation flag.

    Raises:
        WorkspaceIdempotencyConflict: The request id was replayed with another payload.
    """
    expected_head = str(payload.get("expected_head") or "")
    digest = control_plane_payload_hash(workspace.id, ENSURE_OPERATION, payload, expected_head)
    operation = _replayed_operation(workspace.id, request_id, digest, ENSURE_OPERATION)
    if operation is not None:
        return EnsureResult(study=operation.study, operation=operation, created=False)

    locked_chain = ResearchChain.objects.select_for_update().select_related("project").get(pk=chain.pk)
    operation = _replayed_operation(workspace.id, request_id, digest, ENSURE_OPERATION)
    if operation is not None:
        return EnsureResult(study=operation.study, operation=operation, created=False)
    existing = (
        StudyWorkspace.objects.select_related("workspace", "chain__project")
        .filter(chain=locked_chain, workspace=workspace, deleted_at__isnull=True)
        .first()
    )
    if existing is not None:
        working_copy = existing.working_copies.filter(is_default=True, deleted_at__isnull=True).first()
        replay = WorkspaceOperation.objects.create(
            workspace=workspace,
            study=existing,
            working_copy=working_copy,
            actor=actor,
            kind=ENSURE_OPERATION,
            request_id=request_id,
            payload_hash=digest,
            expected_head=expected_head,
            status=WorkspaceOperation.Status.SUCCEEDED,
            result={"study_workspace_id": str(existing.id), "created": False},
        )
        return EnsureResult(study=existing, operation=replay, created=False)

    study = StudyWorkspace.objects.create(
        workspace=workspace,
        chain=locked_chain,
        name=locked_chain.project.name,
        status=StudyWorkspace.Status.ACTIVE,
        is_enabled=True,
        request_id=request_id,
        payload_hash=digest,
        created_by=actor,
    )
    working_copy = WorkspaceWorkingCopy.objects.create(
        study=study,
        owner=locked_chain.owner,
        branch="main",
        storage_key=f"working-copies/{study.id}",
        status=WorkspaceWorkingCopy.Status.PENDING,
        is_default=True,
        created_by=actor,
    )
    operation = WorkspaceOperation.objects.create(
        workspace=workspace,
        study=study,
        working_copy=working_copy,
        actor=actor,
        kind=ENSURE_OPERATION,
        request_id=request_id,
        payload_hash=digest,
        expected_head=expected_head,
        status=WorkspaceOperation.Status.SUCCEEDED,
        result={"study_workspace_id": str(study.id), "created": True},
        created_by=actor,
    )
    return EnsureResult(study=study, operation=operation, created=True)
