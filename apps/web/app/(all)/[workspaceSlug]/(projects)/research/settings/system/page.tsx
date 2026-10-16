/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useState } from "react";
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
import { PlainWorkspaceMemberImportPanel } from "@/components/workspace/settings/member-invitation-import-panel";
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
  const [memberImportType, setMemberImportType] = useState<"plain" | "research">("plain");
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
        <ResearchDetailSurface title="成员导入" hint="普通工作区只发送成员邀请；科研身份导入会创建账号并写入组织关系。">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              {(
                [
                  ["plain", "普通工作区成员"],
                  ["research", "科研身份成员"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={memberImportType === value}
                  className={`h-8 rounded-md px-3 text-13 transition-colors ${
                    memberImportType === value
                      ? "bg-surface-2 font-medium text-primary"
                      : "text-secondary hover:text-primary"
                  }`}
                  onClick={() => setMemberImportType(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            {memberImportType === "research" && (
              <p className="text-11 text-tertiary">
                当前模式沿用科研导入审核，批准后创建或更新账号并写入科研组织关系。
              </p>
            )}
            {memberImportType === "plain" ? (
              <PlainWorkspaceMemberImportPanel workspaceSlug={workspaceSlug} />
            ) : (
              <ResearchUserImportPanel workspaceSlug={workspaceSlug} onRelationsChanged={refreshImportRelations} />
            )}
          </div>
        </ResearchDetailSurface>
      </div>
    </ResearchPageShell>
  );
}

export default observer(WorkspaceResearchSystemSettingsPage);
