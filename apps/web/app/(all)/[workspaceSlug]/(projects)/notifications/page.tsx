/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// plane imports
import { useTranslation } from "@plane/i18n";
// components
import { PageHead } from "@/components/core/page-title";
import { InboxDetail } from "@/components/inbox";
// hooks
import { useWorkspace } from "@/hooks/store/use-workspace";
import type { Route } from "./+types/page";

function WorkspaceInboxPage({ params }: Route.ComponentProps) {
  const { workspaceSlug } = params;
  // plane hooks
  const { t } = useTranslation();
  // hooks
  const { currentWorkspace } = useWorkspace();
  // derived values
  const pageTitle = currentWorkspace?.name
    ? t("notification.page_label", { workspace: currentWorkspace?.name })
    : undefined;

  return (
    <>
      <PageHead title={pageTitle} />
      <InboxDetail workspaceSlug={workspaceSlug} />
    </>
  );
}

export default WorkspaceInboxPage;
