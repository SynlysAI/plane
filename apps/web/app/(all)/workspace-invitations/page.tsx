/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { BoxesOutline, CloseOutline, TickOutline, UserOutline } from "@makeplane/propel/icons";
// components
import { LogoSpinner } from "@/components/common/logo-spinner";
import { EmptySpace, EmptySpaceItem } from "@/components/ui/empty-space";
// constants
import { API_BASE_URL, WORKSPACE_INVITATION } from "@plane/constants";
// helpers
import { EPageTypes } from "@/helpers/authentication.helper";
// hooks
import { useUser } from "@/hooks/store/user";
import { useAppRouter } from "@/hooks/use-app-router";
// wrappers
import { AuthenticationWrapper } from "@/lib/wrappers/authentication-wrapper";
import { WorkspaceService } from "@/services/workspace.service";
import { AuthService } from "@/services/auth.service";
// services

// service initialization
const workspaceService = new WorkspaceService();
const authService = new AuthService();

const WorkspaceInvitationContent = observer(function WorkspaceInvitationContent() {
  // router
  const router = useAppRouter();
  // query params
  const searchParams = useSearchParams();
  const invitation_id = searchParams.get("invitation_id");
  const slug = searchParams.get("slug");
  const token = searchParams.get("token");
  // store hooks
  const { data: currentUser } = useUser();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: invitationDetail, error: invitationError } = useSWR(
    invitation_id && slug && WORKSPACE_INVITATION(invitation_id.toString()),
    invitation_id && slug
      ? () => workspaceService.getWorkspaceInvitation(slug.toString(), invitation_id.toString())
      : null
  );

  const invitationParams = new URLSearchParams();
  if (invitation_id) invitationParams.set("invitation_id", invitation_id);
  if (slug) invitationParams.set("slug", slug);
  if (token) invitationParams.set("token", token);
  const invitationPath = `/workspace-invitations/?${invitationParams}`;
  const authParams = new URLSearchParams({
    email: invitationDetail?.email ?? "",
    invitation_id: invitation_id ?? "",
    slug: slug ?? "",
    next_path: invitationPath,
  });
  const signupPath = `/sign-up?${authParams}`;
  const isMatchingUser = currentUser?.email?.toLowerCase() === invitationDetail?.email.toLowerCase();

  useEffect(() => {
    if (
      invitation_id &&
      slug &&
      !invitationError &&
      invitationDetail &&
      !invitationDetail.responded_at &&
      token &&
      !currentUser?.id
    ) {
      router.replace(signupPath);
    }
  }, [currentUser, invitationDetail, invitationError, invitation_id, slug, token, router, signupPath]);

  const handleInvitation = async (accepted: boolean) => {
    if (!invitationDetail || !token || !currentUser?.id || !isMatchingUser || isSubmitting) return;
    setIsSubmitting(true);
    setActionError(null);
    try {
      await workspaceService.joinWorkspace(invitationDetail.workspace.slug, invitationDetail.id, { accepted, token });
      router.push(accepted ? `/${invitationDetail.workspace.slug}` : "/");
    } catch (error: unknown) {
      console.error("Failed to respond to workspace invitation", error);
      setActionError("Unable to respond to this invitation. Please try again.");
      setIsSubmitting(false);
    }
  };

  const handleSwitchAccount = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setActionError(null);
    try {
      await authService.signOut(API_BASE_URL, invitationPath);
    } catch (error: unknown) {
      console.error("Failed to switch invitation account", error);
      setActionError("Unable to sign out. Please try again.");
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center gap-4 px-4 py-8 break-words">
      {actionError && (
        <p role="alert" className="w-full max-w-lg text-13 text-danger-primary">
          {actionError}
        </p>
      )}
      {!invitation_id || !slug || !token || invitationError || invitationDetail?.responded_at ? (
        <EmptySpace
          title="This invitation link is not active anymore."
          description="Please ask your workspace administrator for a new invitation link."
        >
          <EmptySpaceItem Icon={BoxesOutline} title="Continue to home" href="/" />
        </EmptySpace>
      ) : invitationDetail ? (
        !currentUser?.id ? (
          <LogoSpinner />
        ) : !isMatchingUser ? (
          <EmptySpace
            title={`Join ${invitationDetail.workspace.name}`}
            description={`This invitation is for ${invitationDetail.email}. You are signed in as ${currentUser.email}.`}
          >
            <EmptySpaceItem
              Icon={UserOutline}
              title={isSubmitting ? "Signing out..." : "Switch account to continue"}
              action={() => void handleSwitchAccount()}
            />
          </EmptySpace>
        ) : (
          <EmptySpace
            title={`You have been invited to ${invitationDetail.workspace.name}`}
            description={invitationDetail.email}
          >
            <EmptySpaceItem
              Icon={TickOutline}
              title={isSubmitting ? "Please wait..." : "Accept"}
              action={() => void handleInvitation(true)}
            />
            <EmptySpaceItem Icon={CloseOutline} title="Ignore" action={() => void handleInvitation(false)} />
          </EmptySpace>
        )
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <LogoSpinner />
        </div>
      )}
    </div>
  );
});

function WorkspaceInvitationPage() {
  return (
    <AuthenticationWrapper pageType={EPageTypes.PUBLIC}>
      <WorkspaceInvitationContent />
    </AuthenticationWrapper>
  );
}

export default observer(WorkspaceInvitationPage);
