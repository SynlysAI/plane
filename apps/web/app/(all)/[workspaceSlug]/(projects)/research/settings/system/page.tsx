/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "react-router";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TUserImportBatch } from "@plane/types";
// components
import { ResearchDetailSurface } from "@/components/research/common/research-data-surface";
import { ResearchPageShell } from "@/components/research/common/research-page-shell";
import { ResearchAdminRoleSummary } from "@/components/research/settings/system/admin-role-summary";
import { ResearchInviteCodeManager } from "@/components/research/settings/system/invite-code-manager";
import { ResearchUserImportPanel } from "@/components/research/settings/system/user-import-panel";
import { useMember } from "@/hooks/store/use-member";
import { useResearch } from "@/hooks/store/use-research";

/**
 * Account lifecycle: invite codes and the roster import
 * (SYS-ACC-01 ~ SYS-ACC-12).
 */
function WorkspaceResearchSystemSettingsPage() {
  const { workspaceSlug } = useParams();
  const { t } = useTranslation();
  const memberStore = useMember();
  const research = useResearch();
  if (!workspaceSlug) return null;

  const refreshImportRelations = async (batch: TUserImportBatch) => {
    const unitIds = [...new Set((batch.rows ?? []).flatMap((row) => (row.org_unit ? [row.org_unit] : [])))];
    await Promise.all([
      memberStore.workspace.fetchWorkspaceMembers(workspaceSlug),
      research.fetchOrgUnits(workspaceSlug),
      research.fetchMentorBindings(workspaceSlug),
      ...unitIds.map((unitId) => research.fetchOrgUnitMembers(workspaceSlug, unitId)),
    ]);
  };

  return (
    <ResearchPageShell
      titleKey="research.nav.system"
      descriptionKey="research.system.description"
      section="org"
      navKey="system"
    >
      <div className="flex h-full flex-col gap-4 overflow-y-auto bg-canvas p-5">
        <ResearchAdminRoleSummary />
        <ResearchDetailSurface title={t("research.invite_codes.title")}>
          <ResearchInviteCodeManager workspaceSlug={workspaceSlug} />
        </ResearchDetailSurface>
        <ResearchDetailSurface title={t("research.user_import.title")}>
          <ResearchUserImportPanel workspaceSlug={workspaceSlug} onRelationsChanged={refreshImportRelations} />
        </ResearchDetailSurface>
      </div>
    </ResearchPageShell>
  );
}

export default observer(WorkspaceResearchSystemSettingsPage);
