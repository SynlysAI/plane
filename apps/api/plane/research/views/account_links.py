"""Phase 0 external AccountLink lifecycle endpoints."""

from datetime import timedelta
from hashlib import sha256
from hmac import compare_digest
from secrets import token_urlsafe
from uuid import UUID

from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.db.models import AccountLink, ResearchContextGrant, User, WorkspaceMember
from plane.research.serializers import AccountLinkSerializer
from plane.research.services.idempotency import payload_hash, request_id_from
from plane.research.utils.audit import ResearchAuditAction, ResearchResourceType, record_audit_event
from plane.research.utils.errors import ResearchErrorCode, research_conflict, research_error, research_not_found, research_permission_denied
from plane.research.utils.org import is_workspace_admin
from plane.research.views.base import ResearchAPIView


def _enabled(workspace):
    setting = getattr(workspace, "research_setting", None)
    return bool(setting and setting.research_account_link_enabled)


def _disabled():
    return research_error(
        ResearchErrorCode.SUBMODULE_DISABLED,
        "The account-link switch is disabled for this workspace.",
        status.HTTP_403_FORBIDDEN,
    )


def _hash_code(code):
    return sha256(str(code).encode()).hexdigest()


def _can_manage(actor, workspace, link):
    return link.local_user_id == actor.id or is_workspace_admin(actor, workspace.id)


def _revoke_context_grants(actor, link):
    """Fail closed: account revocation also invalidates live context tokens."""
    ResearchContextGrant.objects.filter(
        user_id=link.local_user_id,
        revoked_at__isnull=True,
    ).update(revoked_at=timezone.now(), updated_by=actor)


class AccountLinkMixin(ResearchAPIView):
    """Shared switch and lookup behaviour for account links."""

    nav_capability = None

    def workspace_or_error(self, request, slug):
        workspace, error = self.get_workspace()
        if error:
            return None, error
        if not _enabled(workspace):
            return None, _disabled()
        return workspace, None

    def load_link(self, workspace, link_id):
        link = AccountLink.objects.filter(pk=link_id).first()
        if link is None:
            return None, research_not_found(
                ResearchErrorCode.ACCOUNT_LINK_NOT_FOUND,
                "Account link not found.",
            )
        if not WorkspaceMember.objects.filter(
            workspace=workspace,
            member_id=link.local_user_id,
            is_active=True,
            deleted_at__isnull=True,
        ).exists():
            return None, research_not_found(
                ResearchErrorCode.ACCOUNT_LINK_NOT_FOUND,
                "Account link not found.",
            )
        return link, None


class ResearchAccountLinkListCreateEndpoint(AccountLinkMixin):
    """Create a pending link or list links visible to the caller."""

    def get(self, request, slug):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        workspace_user_ids = WorkspaceMember.objects.filter(
            workspace=workspace,
            is_active=True,
            deleted_at__isnull=True,
        ).values("member")
        query = AccountLink.objects.filter(local_user_id__in=workspace_user_ids)
        if not is_workspace_admin(request.user, workspace.id):
            query = query.filter(local_user=request.user)
        for field in ("provider", "status", "external_subject", "canonical_identity"):
            if request.GET.get(field):
                query = query.filter(**{field: request.GET[field]})
        links = query.order_by("-created_at")[:200]
        return Response({"results": AccountLinkSerializer(links, many=True).data, "count": len(links)})

    def post(self, request, slug):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        request_id = request_id_from(request)
        provider = str(request.data.get("provider") or "").strip().lower()
        external_subject = str(request.data.get("external_subject") or "").strip()
        if not request_id or not provider or not external_subject:
            return research_error(ResearchErrorCode.ACCOUNT_LINK_CONFLICT, "request_id, provider and external_subject are required.")

        raw_user_id = request.data.get("local_user_id") or str(request.user.id)
        try:
            user_id = UUID(str(raw_user_id))
        except (TypeError, ValueError):
            return research_error(ResearchErrorCode.USER_NOT_FOUND, "local_user_id must be a valid UUID.")
        target_user = User.objects.filter(pk=user_id, is_active=True).first()
        if target_user is None or not WorkspaceMember.objects.filter(
            workspace=workspace,
            member=target_user,
            is_active=True,
            deleted_at__isnull=True,
        ).exists():
            return research_not_found(ResearchErrorCode.USER_NOT_FOUND, "Local user is not an active workspace member.")
        if target_user.id != request.user.id and not is_workspace_admin(request.user, workspace.id):
            return research_permission_denied()

        canonical_identity = str(request.data.get("canonical_identity") or target_user.email).strip().lower()
        digest = payload_hash(request.data)
        existing_request = AccountLink.objects.filter(request_id=request_id).first()
        if existing_request is not None:
            if existing_request.local_user_id != target_user.id:
                return research_not_found(ResearchErrorCode.ACCOUNT_LINK_NOT_FOUND, "Account link not found.")
            if existing_request.payload_hash != digest:
                return research_conflict(ResearchErrorCode.IDEMPOTENCY_CONFLICT, "request_id was already used with another payload.")
            return Response(AccountLinkSerializer(existing_request).data, status=status.HTTP_200_OK)

        conflicts = AccountLink.objects.filter(
            provider=provider,
            deleted_at__isnull=True,
        ).filter(subject_or_foreign_identity_q(external_subject, canonical_identity, target_user.id))
        if conflicts.exists():
            return research_conflict(ResearchErrorCode.ACCOUNT_LINK_CONFLICT, "Provider subject or canonical identity is already linked.")

        verification_code = token_urlsafe(24)
        try:
            with transaction.atomic():
                link = AccountLink.objects.create(
                    canonical_identity=canonical_identity,
                    provider=provider,
                    external_subject=external_subject,
                    local_user=target_user,
                    status=AccountLink.Status.PENDING,
                    bound_by=request.user,
                    request_id=request_id,
                    payload_hash=digest,
                    verification_hash=_hash_code(verification_code),
                    verification_expires_at=timezone.now() + timedelta(minutes=15),
                    created_by=request.user,
                )
        except IntegrityError:
            return research_conflict(ResearchErrorCode.ACCOUNT_LINK_CONFLICT, "Provider subject or canonical identity is already linked.")
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.ACCOUNT_LINK_CREATE,
            resource_type=ResearchResourceType.ACCOUNT_LINK,
            resource_id=link.id,
            actor=request.user,
            metadata={"provider": provider, "local_user_id": str(target_user.id)},
            request=request,
        )
        payload = AccountLinkSerializer(link).data
        payload["verification_code"] = verification_code
        payload["verification_expires_at"] = link.verification_expires_at.isoformat()
        return Response(payload, status=status.HTTP_201_CREATED)


def subject_or_foreign_identity_q(external_subject, canonical_identity, local_user_id=None):
    from django.db.models import Q

    lookup = Q()
    if external_subject:
        lookup |= Q(external_subject__iexact=external_subject)
    if canonical_identity:
        identity_q = Q(canonical_identity__iexact=canonical_identity)
        if local_user_id is not None:
            identity_q &= ~Q(local_user_id=local_user_id)
        lookup |= identity_q
    return lookup


class ResearchAccountLinkConfirmEndpoint(AccountLinkMixin):
    """Verify the one-time code and activate a pending link."""

    def post(self, request, slug, link_id):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        link, error = self.load_link(workspace, link_id)
        if error:
            return error
        if not _can_manage(request.user, workspace, link):
            return research_permission_denied()
        if link.status != AccountLink.Status.PENDING:
            return research_conflict(ResearchErrorCode.ACCOUNT_LINK_CONFLICT, "Only a pending link can be confirmed.")
        supplied_code = str(request.data.get("verification_code") or "")
        expired = link.verification_expires_at is None or link.verification_expires_at <= timezone.now()
        valid_code = bool(link.verification_hash and compare_digest(_hash_code(supplied_code), link.verification_hash))
        if expired or not valid_code:
            return research_error(
                ResearchErrorCode.ACCOUNT_LINK_VERIFICATION_INVALID,
                "Verification code is invalid or expired.",
                status.HTTP_403_FORBIDDEN,
            )
        link.status = AccountLink.Status.ACTIVE
        link.verified_at = timezone.now()
        link.bound_by = request.user
        link.verification_hash = ""
        link.verification_expires_at = None
        link.updated_by = request.user
        link.save(update_fields=["status", "verified_at", "bound_by", "verification_hash", "verification_expires_at", "updated_by", "updated_at"])
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.ACCOUNT_LINK_CONFIRM,
            resource_type=ResearchResourceType.ACCOUNT_LINK,
            resource_id=link.id,
            actor=request.user,
            metadata={"provider": link.provider},
            request=request,
        )
        return Response(AccountLinkSerializer(link).data)


class ResearchAccountLinkUnlinkEndpoint(AccountLinkMixin):
    """Mark a link unlinked and invalidate downstream short-term grants."""

    def post(self, request, slug, link_id):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        link, error = self.load_link(workspace, link_id)
        if error:
            return error
        if not _can_manage(request.user, workspace, link):
            return research_permission_denied()
        if link.status not in (AccountLink.Status.PENDING, AccountLink.Status.ACTIVE):
            return research_conflict(ResearchErrorCode.ACCOUNT_LINK_CONFLICT, "Only a pending or active link can be unlinked.")
        link.status = AccountLink.Status.UNLINKED
        link.unlinked_at = timezone.now()
        link.updated_by = request.user
        link.save(update_fields=["status", "unlinked_at", "updated_by", "updated_at"])
        _revoke_context_grants(request.user, link)
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.ACCOUNT_LINK_UNLINK,
            resource_type=ResearchResourceType.ACCOUNT_LINK,
            resource_id=link.id,
            actor=request.user,
            metadata={"provider": link.provider},
            request=request,
        )
        return Response(AccountLinkSerializer(link).data)


class ResearchAccountLinkRevokeEndpoint(AccountLinkMixin):
    """Administratively revoke a link and all delegated access."""

    def post(self, request, slug, link_id):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        if not is_workspace_admin(request.user, workspace.id):
            return research_permission_denied()
        link, error = self.load_link(workspace, link_id)
        if error:
            return error
        if link.status == AccountLink.Status.REVOKED:
            return Response(AccountLinkSerializer(link).data)
        link.status = AccountLink.Status.REVOKED
        link.unlinked_at = timezone.now()
        link.updated_by = request.user
        link.save(update_fields=["status", "unlinked_at", "updated_by", "updated_at"])
        _revoke_context_grants(request.user, link)
        record_audit_event(
            workspace=workspace,
            action=ResearchAuditAction.ACCOUNT_LINK_REVOKE,
            resource_type=ResearchResourceType.ACCOUNT_LINK,
            resource_id=link.id,
            actor=request.user,
            metadata={"provider": link.provider},
            request=request,
        )
        return Response(AccountLinkSerializer(link).data)


class ResearchAccountLinkConflictEndpoint(AccountLinkMixin):
    """Query existing provider subjects and canonical identities."""

    def get(self, request, slug):
        workspace, error = self.workspace_or_error(request, slug)
        if error:
            return error
        provider = str(request.GET.get("provider") or "").strip().lower()
        external_subject = str(request.GET.get("external_subject") or "").strip()
        canonical_identity = str(request.GET.get("canonical_identity") or "").strip().lower()
        if not provider or not (external_subject or canonical_identity):
            return research_error(ResearchErrorCode.ACCOUNT_LINK_CONFLICT, "provider and external_subject or canonical_identity are required.")
        workspace_user_ids = WorkspaceMember.objects.filter(
            workspace=workspace,
            is_active=True,
            deleted_at__isnull=True,
        ).values("member")
        query = AccountLink.objects.filter(
            local_user_id__in=workspace_user_ids,
            provider=provider,
            deleted_at__isnull=True,
        )
        query = query.filter(subject_or_foreign_identity_q(external_subject, canonical_identity))
        if not is_workspace_admin(request.user, workspace.id):
            query = query.filter(local_user=request.user)
        links = list(query.order_by("-created_at")[:100])
        return Response({"results": AccountLinkSerializer(links, many=True).data, "count": len(links)})
