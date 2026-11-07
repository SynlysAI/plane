"""Registration service for immutable research resource references."""

from dataclasses import dataclass
from uuid import UUID

from django.db import transaction

from plane.db.models import StudyWorkspace, WorkspaceOperation, WorkspaceResourceReference
from plane.research.services.idempotency import payload_hash
from plane.research.services.workspaces.control_plane import WorkspaceIdempotencyConflict


REGISTER_OPERATION = "REGISTER_RESOURCE_REF"


def _json_safe_payload(payload):
    """Normalize serializer UUID values to the contract's JSON representation.

    Args:
        payload: Serializer-validated contract fields.

    Returns:
        A JSON-serializable payload with UUID values rendered as strings.
    """
    return {key: str(value) if isinstance(value, UUID) else value for key, value in payload.items()}


def _replayed_registration(study, request_id, digest):
    """Return a matching registration replay, or ``None`` for a new request.

    Args:
        study: StudyWorkspace expected by the operation.
        request_id: Caller-provided idempotency key.
        digest: Canonical fixed-reference digest.

    Returns:
        The matching operation when the same payload is replayed.

    Raises:
        WorkspaceIdempotencyConflict: The key belongs to another intent or payload.
    """
    operation = (
        WorkspaceOperation.objects.select_related("study", "study__workspace").filter(request_id=request_id).first()
    )
    if operation is None:
        return None
    replayed_digest = operation.result.get("digest")
    if (
        operation.study_id != study.id
        or operation.workspace_id != study.workspace_id
        or operation.kind != REGISTER_OPERATION
        or operation.payload_hash != digest
        or replayed_digest != digest
    ):
        raise WorkspaceIdempotencyConflict
    return operation


@dataclass(frozen=True)
class RegisterResult:
    """The fixed reference and operation produced by one registration."""

    reference: WorkspaceResourceReference
    operation: WorkspaceOperation
    created: bool


@transaction.atomic
def register_resource_reference(study, actor, request_id, validated_payload):
    """Persist a validated v1 fixed reference with idempotent replay.

    Args:
        study: StudyWorkspace that owns the reference.
        actor: User registering the reference.
        request_id: Stable idempotency key.
        validated_payload: Serializer-normalized contract payload.

    Returns:
        A :class:`RegisterResult` with the immutable reference and operation.

    Raises:
        WorkspaceIdempotencyConflict: The request id was replayed with another payload.
    """
    normalized_payload = _json_safe_payload(validated_payload)
    digest = payload_hash(normalized_payload)
    operation = _replayed_registration(study, request_id, digest)
    if operation is not None:
        reference = WorkspaceResourceReference.objects.select_related("study").get(study=study, digest=digest)
        return RegisterResult(reference=reference, operation=operation, created=False)

    StudyWorkspace.objects.select_for_update().get(pk=study.pk)
    operation = _replayed_registration(study, request_id, digest)
    if operation is not None:
        reference = WorkspaceResourceReference.objects.select_related("study").get(study=study, digest=digest)
        return RegisterResult(reference=reference, operation=operation, created=False)
    reference, created = WorkspaceResourceReference.objects.get_or_create(
        study=study,
        digest=digest,
        defaults={
            "schema_version": validated_payload["schema_version"],
            "kind": validated_payload["kind"],
            "repository_id": validated_payload.get("repository_id"),
            "commit": validated_payload.get("commit", ""),
            "path": validated_payload.get("path", ""),
            "blob_oid": validated_payload.get("blob_oid", ""),
            "lfs_oid": validated_payload.get("lfs_oid", ""),
            "asset_revision_id": validated_payload.get("asset_revision_id"),
            "logical_asset_id": validated_payload.get("logical_asset_id"),
            "external_reference": validated_payload.get("external_reference", ""),
            "content_sha256": validated_payload["content_sha256"],
            "size": validated_payload["size"],
            "source_system": validated_payload.get("source_system", ""),
            "source_run_id": validated_payload.get("source_run_id", ""),
            "payload": normalized_payload,
        },
    )
    operation = WorkspaceOperation.objects.create(
        workspace=study.workspace,
        study=study,
        actor=actor,
        kind=REGISTER_OPERATION,
        request_id=request_id,
        payload_hash=digest,
        status=WorkspaceOperation.Status.SUCCEEDED,
        result={"digest": digest, "created": created},
        created_by=actor,
    )
    return RegisterResult(reference=reference, operation=operation, created=created)
