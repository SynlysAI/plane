# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from plane.db.models import Profile, Workspace, WorkspaceMemberInvite


def get_redirection_path(user):
    # Handle redirections
    profile, _ = Profile.objects.get_or_create(user=user)

    # Redirect to onboarding if the user is not onboarded yet
    if not profile.is_onboarded:
        return "onboarding"

    # Redirect to the last workspace if the user has last workspace
    if (
        profile.last_workspace_id
        and Workspace.objects.filter(
            pk=profile.last_workspace_id,
            workspace_member__member_id=user.id,
            workspace_member__is_active=True,
        ).exists()
    ):
        workspace = Workspace.objects.filter(
            pk=profile.last_workspace_id,
            workspace_member__member_id=user.id,
            workspace_member__is_active=True,
        ).first()
        if workspace is not None and workspace.slug == "pi":
            from plane.db.models import WorkspaceResearchSetting

            private_setting = WorkspaceResearchSetting.objects.filter(
                workspace=workspace,
                purpose=WorkspaceResearchSetting.Purpose.PI_PRIVATE,
                main_pi=user,
                deleted_at__isnull=True,
            ).first()
            if private_setting is not None:
                public_workspace = Workspace.objects.filter(
                    slug="public",
                    workspace_member__member_id=user.id,
                    workspace_member__is_active=True,
                ).first()
                if public_workspace is not None:
                    return public_workspace.slug
        return f"{workspace.slug}"

    fallback_workspace = (
        Workspace.objects.filter(workspace_member__member_id=user.id, workspace_member__is_active=True)
        .order_by("created_at")
        .first()
    )
    # Redirect to fallback workspace
    if fallback_workspace:
        return f"{fallback_workspace.slug}"

    # Redirect to invitations if the user has unaccepted invitations
    if WorkspaceMemberInvite.objects.filter(email=user.email).count():
        return "invitations"

    # Redirect the user to create workspace
    return "create-workspace"
