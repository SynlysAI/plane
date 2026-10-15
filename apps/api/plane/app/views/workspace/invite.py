# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
from datetime import datetime

import jwt

# Django imports
from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import IntegrityError, transaction
from django.http import HttpResponse
from django.utils import timezone

# Third party modules
from rest_framework import status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response

# Module imports
from plane.app.permissions import WorkSpaceAdminPermission
from plane.app.serializers import (
    WorkSpaceMemberInviteSerializer,
    WorkSpaceMemberInvitePublicSerializer,
    WorkSpaceMemberSerializer,
)
from plane.app.services.workspace.member_invitation_import import (
    MemberInvitationImportError,
    MemberInvitationRow,
    build_member_invitation_template,
    normalise_boolean,
    normalise_member_role,
    parse_member_invitation_workbook,
)
from plane.app.views.base import BaseAPIView
from plane.bgtasks.workspace_invitation_task import workspace_invitation
from plane.db.models import ResearchUserProfile, User, Workspace, WorkspaceMember, WorkspaceMemberInvite
from plane.utils.cache import invalidate_cache, invalidate_cache_directly
from plane.utils.host import base_host
from .. import BaseViewSet


def _basic_research_category(value):
    """Normalize an optional basic research profile category.

    Args:
        value: The category supplied by a client or upload form.

    Returns:
        A valid category, ``OTHER`` for an empty value, or ``None`` when invalid.
    """
    category = str(value or "").strip().upper() or ResearchUserProfile.Category.OTHER
    return category if category in ResearchUserProfile.Category.values else None


def _request_rows(request):
    """Convert the existing invitation JSON payload to normalized rows.

    Args:
        request: The DRF request containing ``emails``.

    Returns:
        ``(rows, errors)`` where errors carry the one-based payload row number.
    """
    emails = request.data.get("emails", [])
    if not isinstance(emails, list):
        return [], [{"row_number": 1, "email": "", "message": "emails must be a list"}]

    rows = []
    errors = []
    seen_emails = {}
    for index, item in enumerate(emails, start=1):
        if not isinstance(item, dict):
            errors.append({"row_number": index, "email": "", "message": "Each invitation must be an object"})
            continue
        email = str(item.get("email") or "").strip().lower()
        display_name = str(item.get("display_name") or "").strip()
        role = 5 if item.get("role") is None else normalise_member_role(item.get("role"))
        enabled = normalise_boolean(item.get("research_profile_enabled", False))
        category = _basic_research_category(item.get("research_profile_category", "")) if enabled else ""
        message = ""
        if not email:
            message = "Email is required"
        elif len(email) > 255:
            message = "Email must be at most 255 characters"
        else:
            try:
                validate_email(email)
            except ValidationError:
                message = f"Invalid email - {email}"
        if not message and "display_name" in item and not display_name:
            message = "Name is required"
        if not message and len(display_name) > 255:
            message = "Name must be at most 255 characters"
        if not message and role is None:
            message = "Role must be admin, member, or guest"
        if not message and category is None:
            message = "Invalid research profile category"
        if not message and email in seen_emails:
            message = f"Email duplicates payload row {seen_emails[email]}"
        if message:
            errors.append({"row_number": index, "email": email, "name": display_name, "message": message})
            continue
        seen_emails[email] = index
        rows.append(
            MemberInvitationRow(
                row_number=index,
                display_name=display_name,
                email=email,
                role=role,
                research_profile_enabled=enabled,
                research_profile_category=category,
            )
        )
    return rows, errors


def _workspace_validation_errors(workspace, requesting_role, rows):
    """Validate invitation rows against current members and invitations.

    Args:
        workspace: The target workspace.
        requesting_role: The inviting member's workspace role.
        rows: Normalized invitation candidate rows.

    Returns:
        ``(errors, existing_members)`` suitable for a row-level API response.
    """
    errors = []
    for row in rows:
        if row.role > requesting_role:
            errors.append(
                {
                    "row_number": row.row_number,
                    "email": row.email,
                    "name": row.display_name,
                    "message": "You cannot invite a user with a higher role",
                }
            )

    emails = [row.email for row in rows]
    existing_members = WorkspaceMember.objects.filter(
        workspace_id=workspace.id,
        member__email__in=emails,
        is_active=True,
    ).select_related("member", "member__avatar_asset")
    existing_emails = {member.member.email.lower() for member in existing_members}
    pending_emails = set(
        WorkspaceMemberInvite.objects.filter(workspace_id=workspace.id, email__in=emails).values_list(
            "email", flat=True
        )
    )
    for row in rows:
        if row.email in existing_emails:
            errors.append(
                {
                    "row_number": row.row_number,
                    "email": row.email,
                    "name": row.display_name,
                    "message": "The user is already an active member of this workspace",
                }
            )
        elif row.email.lower() in pending_emails:
            errors.append(
                {
                    "row_number": row.row_number,
                    "email": row.email,
                    "name": row.display_name,
                    "message": "The user already has a pending invitation to this workspace",
                }
            )
    return errors, existing_members


def _invitation_objects(workspace, actor, rows):
    """Build invitation model instances from normalized rows."""
    return [
        WorkspaceMemberInvite(
            email=row.email,
            display_name=row.display_name,
            workspace_id=workspace.id,
            token=jwt.encode(
                {"email": row.email, "timestamp": datetime.now().timestamp()},
                settings.SECRET_KEY,
                algorithm="HS256",
            ),
            role=row.role,
            research_profile_enabled=row.research_profile_enabled,
            research_profile_category=row.research_profile_category,
            created_by=actor,
        )
        for row in rows
    ]


def _create_invitations(workspace, actor, rows, current_site, inviter_email):
    """Atomically create invitations and queue their emails after commit."""
    invitations = _invitation_objects(workspace, actor, rows)

    def send_emails():
        """Queue notification emails after the invitation rows are durable."""
        for invitation in invitations:
            workspace_invitation.delay(
                invitation.email,
                workspace.id,
                invitation.token,
                current_site,
                inviter_email,
            )

    with transaction.atomic():
        created = WorkspaceMemberInvite.objects.bulk_create(invitations, batch_size=10)
        transaction.on_commit(send_emails)
    return created


def _apply_basic_research_profile(invitation, user):
    """Create an optional basic research profile without organization relations.

    Args:
        invitation: The accepted workspace invitation.
        user: The authenticated user accepting that invitation.
    """
    if not invitation.research_profile_enabled:
        return
    category = invitation.research_profile_category
    if category not in ResearchUserProfile.Category.values:
        category = ResearchUserProfile.Category.OTHER
    ResearchUserProfile.objects.get_or_create(
        user=user,
        defaults={"category": category},
    )


class WorkspaceInvitationsViewset(BaseViewSet):
    """Endpoint for creating, listing and  deleting workspaces"""

    serializer_class = WorkSpaceMemberInviteSerializer
    model = WorkspaceMemberInvite

    permission_classes = [WorkSpaceAdminPermission]

    def get_queryset(self):
        return self.filter_queryset(
            super()
            .get_queryset()
            .filter(workspace__slug=self.kwargs.get("slug"))
            .select_related("workspace", "workspace__owner", "created_by")
        )

    def create(self, request, slug):
        rows, errors = _request_rows(request)
        if not rows and not errors:
            errors = [{"row_number": 1, "email": "", "message": "Emails are required"}]
        if not errors:
            requesting_user = WorkspaceMember.objects.get(workspace__slug=slug, member=request.user, is_active=True)
            workspace = Workspace.objects.get(slug=slug)
            errors, workspace_members = _workspace_validation_errors(workspace, requesting_user.role, rows)
        else:
            workspace_members = WorkspaceMember.objects.none()

        if errors:
            if any(error["message"] == "Email is required" for error in errors):
                return Response({"error": "Emails are required"}, status=status.HTTP_400_BAD_REQUEST)
            if any(error["message"] == "You cannot invite a user with a higher role" for error in errors):
                return Response(
                    {"error": "You cannot invite a user with higher role"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if workspace_members:
                return Response(
                    {
                        "error": "Some users are already member of workspace",
                        "workspace_users": WorkSpaceMemberSerializer(workspace_members, many=True).data,
                        "rows": errors,
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            return Response(
                {"error": "Some invitations are invalid", "rows": errors},
                status=status.HTTP_400_BAD_REQUEST,
            )

        workspace = Workspace.objects.get(slug=slug)
        current_site = base_host(request=request, is_app=True)
        try:
            _create_invitations(workspace, request.user, rows, current_site, request.user.email)
        except IntegrityError:
            return Response(
                {"error": "An invitation changed while this request was being processed"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response({"message": "Emails sent successfully"}, status=status.HTTP_200_OK)

    def destroy(self, request, slug, pk):
        workspace_member_invite = WorkspaceMemberInvite.objects.get(pk=pk, workspace__slug=slug)
        workspace_member_invite.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class WorkspaceMemberInvitationImportTemplateEndpoint(BaseAPIView):
    """Download the three-column workbook used by plain workspace imports."""

    permission_classes = [WorkSpaceAdminPermission]

    def get(self, request, slug):
        """Return an XLSX template with name, email, and role headers."""
        response = HttpResponse(
            build_member_invitation_template(),
            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        response["Content-Disposition"] = 'attachment; filename="workspace-member-invitations.xlsx"'
        return response


class WorkspaceMemberInvitationImportEndpoint(BaseAPIView):
    """Import plain workspace member invitations from XLSX or CSV."""

    permission_classes = [WorkSpaceAdminPermission]

    def post(self, request, slug):
        """Validate a whole invitation workbook, then create pending invitations."""
        workspace = Workspace.objects.get(slug=slug)
        requesting_user = WorkspaceMember.objects.get(workspace=workspace, member=request.user, is_active=True)
        upload = request.FILES.get("file")
        if upload is None:
            return Response(
                {"error": "请选择要导入的 Excel 或 CSV 文件。", "rows": []},
                status=status.HTTP_400_BAD_REQUEST,
            )

        enabled = normalise_boolean(request.data.get("research_profile_enabled", False))
        category = _basic_research_category(request.data.get("research_profile_category", ""))
        if enabled and category is None:
            return Response(
                {
                    "error": "科研档案类别无效。",
                    "rows": [
                        {
                            "row_number": None,
                            "name": "",
                            "email": "",
                            "message": "科研档案类别必须是学生、博士后、导师、PI、员工或其他。",
                        }
                    ],
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not enabled:
            category = ""

        try:
            rows = parse_member_invitation_workbook(
                upload.read(),
                upload.name,
                research_profile_enabled=enabled,
                research_profile_category=category,
            )
        except MemberInvitationImportError as exc:
            return Response({"error": exc.message, "rows": exc.rows}, status=status.HTTP_400_BAD_REQUEST)

        errors, _ = _workspace_validation_errors(workspace, requesting_user.role, rows)
        if errors:
            return Response(
                {"error": "成员导入表存在无效行。", "rows": errors},
                status=status.HTTP_400_BAD_REQUEST,
            )

        current_site = base_host(request=request, is_app=True)
        try:
            invitations = _create_invitations(workspace, request.user, rows, current_site, request.user.email)
        except IntegrityError:
            return Response(
                {
                    "error": "邀请在处理过程中发生变化，请刷新后重试。",
                    "rows": [],
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            {
                "message": "成员邀请已批量发送。",
                "created": len(invitations),
                "invitations": WorkSpaceMemberInviteSerializer(invitations, many=True).data,
            },
            status=status.HTTP_200_OK,
        )


class WorkspaceJoinEndpoint(BaseAPIView):
    permission_classes = [AllowAny]
    """Invitation response endpoint the user can respond to the invitation"""

    @invalidate_cache(path="/api/workspaces/", user=False)
    @invalidate_cache(path="/api/users/me/workspaces/", multiple=True)
    @invalidate_cache(
        path="/api/workspaces/:slug/members/",
        user=False,
        multiple=True,
        url_params=True,
    )
    @invalidate_cache(path="/api/users/me/settings/", multiple=True)
    def post(self, request, slug, pk):
        workspace_invite = WorkspaceMemberInvite.objects.get(pk=pk, workspace__slug=slug)

        token = request.data.get("token", "")

        # Validate the token to verify the user received the invitation email
        if not token or workspace_invite.token != token:
            return Response(
                {"error": "You do not have permission to join the workspace"},
                status=status.HTTP_403_FORBIDDEN,
            )

        # Require an authenticated session — the accepting user must be the
        # person who was invited.  Without this check an attacker who registers
        # with the invited address (email-squat) and obtains the token via the
        # GET endpoint can steal the workspace membership (GHSA-4vj8-p63v-8p24).
        if not request.user.is_authenticated:
            return Response(
                {"error": "Authentication required to accept workspace invitation"},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        if request.user.email.lower() != workspace_invite.email.lower():
            return Response(
                {"error": "You do not have permission to accept this invitation"},
                status=status.HTTP_403_FORBIDDEN,
            )

        # If already responded then return error
        if workspace_invite.responded_at is None:
            workspace_invite.accepted = request.data.get("accepted", False)
            workspace_invite.responded_at = timezone.now()
            workspace_invite.save()

            if workspace_invite.accepted:
                # Check if the user created account after invitation
                user = User.objects.filter(email=workspace_invite.email).first()

                # If the user is present then create the workspace member
                if user is not None:
                    # Check if the user was already a member of workspace then activate the user
                    workspace_member = WorkspaceMember.objects.filter(
                        workspace=workspace_invite.workspace, member=user
                    ).first()
                    if workspace_member is not None:
                        workspace_member.is_active = True
                        workspace_member.role = workspace_invite.role
                        workspace_member.save()
                    else:
                        # Create a Workspace
                        _ = WorkspaceMember.objects.create(
                            workspace=workspace_invite.workspace,
                            member=user,
                            role=workspace_invite.role,
                        )

                    _apply_basic_research_profile(workspace_invite, user)

                    # Set the user last_workspace_id to the accepted workspace
                    user.last_workspace_id = workspace_invite.workspace.id
                    user.save()

                    # Delete the invitation
                    workspace_invite.delete()

                return Response(
                    {"message": "Workspace Invitation Accepted"},
                    status=status.HTTP_200_OK,
                )

            # Workspace invitation rejected
            return Response(
                {"message": "Workspace Invitation was not accepted"},
                status=status.HTTP_200_OK,
            )

        return Response(
            {"error": "You have already responded to the invitation request"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    def get(self, request, slug, pk):
        workspace_invitation = WorkspaceMemberInvite.objects.get(workspace__slug=slug, pk=pk)
        # Use the public serializer that omits the token and invite_link fields so
        # that an unauthenticated caller cannot retrieve the acceptance token
        # (GHSA-86mg-259g-pwgg / GHSA-gf48-p6jp-cwc4).
        serializer = WorkSpaceMemberInvitePublicSerializer(workspace_invitation)
        return Response(serializer.data, status=status.HTTP_200_OK)


class UserWorkspaceInvitationsViewSet(BaseViewSet):
    serializer_class = WorkSpaceMemberInviteSerializer
    model = WorkspaceMemberInvite

    def get_queryset(self):
        return self.filter_queryset(
            super().get_queryset().filter(email=self.request.user.email).select_related("workspace")
        )

    @invalidate_cache(path="/api/workspaces/", user=False)
    @invalidate_cache(path="/api/users/me/workspaces/", multiple=True)
    def create(self, request):
        invitations = request.data.get("invitations", [])
        workspace_invitations = WorkspaceMemberInvite.objects.filter(
            pk__in=invitations, email=request.user.email
        ).order_by("-created_at")

        # If the user is already a member of workspace and was deactivated then activate the user
        for invitation in workspace_invitations:
            invalidate_cache_directly(
                path=f"/api/workspaces/{invitation.workspace.slug}/members/",
                user=False,
                request=request,
                multiple=True,
            )
            # Update the WorkspaceMember for this specific invitation
            WorkspaceMember.objects.filter(workspace_id=invitation.workspace_id, member=request.user).update(
                is_active=True, role=invitation.role
            )

        # Bulk create the user for all the workspaces
        WorkspaceMember.objects.bulk_create(
            [
                WorkspaceMember(
                    workspace=invitation.workspace,
                    member=request.user,
                    role=invitation.role,
                    created_by=request.user,
                )
                for invitation in workspace_invitations
            ],
            ignore_conflicts=True,
        )

        for invitation in workspace_invitations:
            _apply_basic_research_profile(invitation, request.user)

        # Delete joined workspace invites
        workspace_invitations.delete()

        return Response(status=status.HTTP_204_NO_CONTENT)
