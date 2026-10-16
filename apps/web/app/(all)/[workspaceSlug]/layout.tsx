/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { lazy, Suspense } from "react";
import { Outlet } from "react-router";
import { AuthenticationWrapper } from "@/lib/wrappers/authentication-wrapper";
import { PasswordResetGate } from "@/components/account/password-reset-gate";
import { WorkspaceContentWrapper } from "@/components/workspace/content-wrapper";
import { AppRailVisibilityProvider } from "@/lib/app-rail";
import { GlobalModals } from "@/components/common/modal/global";
import { WorkspaceAuthWrapper } from "@/layouts/auth-layout/workspace-wrapper";
import type { Route } from "./+types/layout";

const AIAssistantRoot = lazy(() =>
  import("@/components/assistant/ai-assistant-root").then((module) => ({
    default: module.AIAssistantRoot,
  }))
);

export default function WorkspaceLayout(props: Route.ComponentProps) {
  const { workspaceSlug } = props.params;

  return (
    <AuthenticationWrapper>
      <WorkspaceAuthWrapper>
        <AppRailVisibilityProvider>
          <WorkspaceContentWrapper>
            <PasswordResetGate />
            <GlobalModals workspaceSlug={workspaceSlug} />
            <Suspense fallback={null}>
              <AIAssistantRoot />
            </Suspense>
            <Outlet />
          </WorkspaceContentWrapper>
        </AppRailVisibilityProvider>
      </WorkspaceAuthWrapper>
    </AuthenticationWrapper>
  );
}
