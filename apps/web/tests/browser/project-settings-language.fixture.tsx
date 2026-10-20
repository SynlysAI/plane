import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { setLanguage, TranslationProvider, useTranslation } from "@plane/i18n";
import type { RootStore } from "@/store/root.store";
import { StoreContext } from "@/lib/store-context";
import { ProjectSettingsSidebarHeader } from "@/components/settings/project/sidebar/header";
import { ProjectSettingsSidebarItemCategories } from "@/components/settings/project/sidebar/item-categories";
import { ProjectSettingsMemberDefaults } from "@/components/project/project-settings-member-defaults";
import { AccountTypeColumn } from "@/components/project/settings/member-columns";
import { MemberListFiltersDropdown } from "@/components/project/dropdowns/filters/member-list";
import { SendProjectInvitationModal } from "@/components/project/send-project-invitation-modal";
// oxlint-disable-next-line import/no-unassigned-import -- Browser fixture uses real application styles.
import "../../styles/globals.css";

const project = {
  id: "project",
  name: "Research Alpha",
  logo_props: {},
  workspace: { id: "workspace" },
  project_lead: null,
  default_assignee: null,
  guest_view_all_features: false,
};
const candidate = {
  id: "person",
  first_name: "Alice",
  last_name: "Chen",
  display_name: "Alice",
  email: "alice@example.com",
  avatar_url: "",
};
const context = {
  projectRoot: {
    project: {
      currentProjectDetails: project,
      getPartialProjectById: () => project,
      fetchProjectDetails: async () => project,
      updateProject: async () => project,
    },
  },
  workspaceRoot: { currentWorkspace: { slug: "lab" } },
  user: {
    data: { id: "current" },
    permission: { allowPermissions: () => true, getProjectRoleByWorkspaceSlugAndProjectId: () => 20 },
  },
  memberRoot: {
    getUserDetails: () => candidate,
    project: {
      getProjectMemberIds: () => [],
      getProjectMemberDetails: () => null,
      bulkAddMembersToProject: async () => undefined,
    },
    workspace: { workspaceMemberIds: ["person"], getWorkspaceMemberDetails: () => ({ member: candidate, role: 15 }) },
  },
} as unknown as RootStore;

function Fixture() {
  const [invite, setInvite] = useState(false);
  const { changeLanguage, t } = useTranslation();
  return (
    <div className="flex min-h-screen bg-canvas">
      <aside className="w-64 shrink-0 border-r border-subtle bg-surface-1">
        <ProjectSettingsSidebarHeader projectId="project" />
        <ProjectSettingsSidebarItemCategories projectId="project" />
      </aside>
      <main className="min-w-0 flex-1 p-6">
        <div className="flex gap-3">
          <button type="button" onClick={() => changeLanguage("zh-CN")}>
            简体中文
          </button>
          <button type="button" onClick={() => changeLanguage("en")}>
            English
          </button>
          <button type="button" onClick={() => changeLanguage("fr")}>
            Français
          </button>
        </div>
        <h1 className="text-22 mt-6">{t("project_settings.members.label")}</h1>
        <ProjectSettingsMemberDefaults workspaceSlug="lab" projectId="project" />
        <div className="flex items-center gap-4">
          <MemberListFiltersDropdown memberType="project" appliedFilters={[]} handleUpdate={() => undefined} />
          <button type="button" onClick={() => setInvite(true)}>
            {t("add_member")}
          </button>
          <AccountTypeColumn
            rowData={
              { member: { member: candidate }, role: 15, original_role: null, inherits_organization: true } as never
            }
            currentProjectRole={20}
            workspaceSlug="lab"
            projectId="project"
          />
        </div>
        <SendProjectInvitationModal
          isOpen={invite}
          onClose={() => setInvite(false)}
          workspaceSlug="lab"
          projectId="project"
        />
      </main>
    </div>
  );
}
await setLanguage("zh-CN");
createRoot(document.getElementById("root")!).render(
  <StoreContext.Provider value={context}>
    <TranslationProvider>
      <MemoryRouter initialEntries={["/lab/settings/projects/project/members"]}>
        <Routes>
          <Route path="/:workspaceSlug/settings/projects/:projectId/members" element={<Fixture />} />
        </Routes>
      </MemoryRouter>
    </TranslationProvider>
  </StoreContext.Provider>
);
