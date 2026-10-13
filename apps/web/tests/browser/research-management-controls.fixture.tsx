/** Actual management components backed by an isolated read-only API fixture. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { AxiosHeaders } from "axios";
import { TranslationProvider, initPromise } from "@plane/i18n";
import { StoreProvider, store } from "@/lib/store-context";
import { APIService } from "@/services/api.service";
import { ResearchChainDetail } from "@/components/research/chains/research-chain-detail";
import { ResearchTemplateList } from "@/components/research/settings/templates/template-list";
import { ResearchIdentityMappingTable } from "@/components/research/settings/identity/identity-mapping-table";
import { ResearchAuditEventTable } from "@/components/research/audit/audit-event-table";
import { ResearchInviteCodeManager } from "@/components/research/settings/system/invite-code-manager";
import { ResearchUserImportPanel } from "@/components/research/settings/system/user-import-panel";
import { ResearchOrgTreeEditor } from "@/components/research/settings/org/org-tree-editor";
import { ResearchPlatformSettingsForm } from "@/components/research/settings/platform/platform-settings-form";
import { IntegrationSettings } from "@/components/research/integrations/integration-settings";
import { FeedbackDialog } from "@/components/research/feedback/feedback-dialog";
// oxlint-disable-next-line import/no-unassigned-import -- shared fixture styles
import "./research-home-workbench.fixture.css";

const workspaceSlug = "sample";
const now = "2026-10-12T03:05:18Z";
const people = [
  { id: "person-1", display_name: "肖旭", email: "xiaoxu@example.org" },
  { id: "person-2", display_name: "李导师", email: "teacher@example.org" },
];
const units = [
  { id: "root", name: "科研组织", unit_type: "ROOT", parent: null, depth: 0, is_active: true, business_category: null },
  {
    id: "group-1",
    name: "金属化课题组",
    unit_type: "GROUP",
    parent: "root",
    depth: 1,
    is_active: true,
    business_category: "BASIC_RESEARCH",
  },
];
const memberships = [
  {
    id: "membership-1",
    user: "person-1",
    org_unit: "group-1",
    member_detail: people[0],
    org_role: "STUDENT",
    is_primary: true,
    effective_from: "2026-01-01",
    effective_to: null,
  },
];
const provisioning = {
  org_units: units.map((unit) => ({ ...unit, display_path: `科研组织 / ${unit.name}` })),
  advisors: [people[1]],
  profile_categories: [
    { value: "STUDENT", label: "学生" },
    { value: "ADVISOR", label: "导师" },
  ],
};
const settings = {
  main_pi: "11111111-2222-4333-8444-555555555555",
  main_pi_name: "李导师",
  timezone: "Asia/Shanghai",
  required_reporter_categories: ["STUDENT"],
  default_report_visibility: "DIRECT_ADVISOR",
  weekly_default_visibility: null,
  monthly_default_visibility: null,
  module_enabled: true,
  org_enabled: true,
  report_enabled: true,
  approval_enabled: true,
  research_chain_enabled: true,
  research_ia_v2: true,
};

APIService.prototype.get = async (rawUrl) => {
  const path = new URL(rawUrl, window.location.origin).pathname;
  let data: unknown = { results: [], count: 0 };
  if (path.endsWith("/identity/me/"))
    data = {
      module_enabled: true,
      workspace_enabled: true,
      sections: { org: true, reports: true, approvals: true, research_chain: true, integrations: true },
      user: {
        id: "person-1",
        is_system_admin: true,
        is_workspace_admin: true,
        is_main_pi: true,
        org_units: [{ org_unit: "group-1", is_primary: true }],
        mentor_ids: [],
        mentee_ids: [],
      },
    };
  else if (path.endsWith("/chains/chain-1/members/"))
    data = {
      data: [
        { user_id: "person-1", display_name: "肖旭", role: "OWNER", is_owner: true },
        { user_id: "person-2", display_name: "李导师", role: "ADMIN", is_owner: false },
      ],
    };
  else if (path.endsWith("/chains/chain-1/"))
    data = {
      data: {
        id: "chain-1",
        project: "project-1",
        project_name: "科研链功能测试",
        status: "ACTIVE",
        owner: "person-1",
        owner_name: "肖旭",
        visibility: "PRIVATE",
        current_node: null,
        open_task_count: 0,
        updated_at: now,
      },
    };
  else if (path.endsWith("/chains/chain-1/nodes/")) data = { data: [] };
  else if (path.endsWith("/org-units/group-1/members/") || path.endsWith("/org-units/root/members/"))
    data = { results: memberships };
  else if (path.endsWith("/members/"))
    data = people.map((member, index) => ({
      id: `workspace-member-${index}`,
      member,
      role: 20,
      is_active: true,
      created_at: now,
    }));
  else if (path.endsWith("/org-units/")) data = { results: units };
  else if (path.endsWith("/org/incomplete/"))
    data = { counts: {}, missing_primary_org: [], missing_primary_advisor: [], unclassified_org_units: [] };
  else if (path.endsWith("/reports/templates/"))
    data = {
      results: [{ id: "template-1", name: "科研周报", report_type: "WEEKLY", is_default: true, is_active: true }],
    };
  else if (path.endsWith("/identity/mappings/"))
    data = {
      results: [
        {
          id: "mapping-1",
          user: "person-1",
          user_detail: people[0],
          provider: "AI4MS",
          subject: "xiaoxu",
          employee_id: "2026001",
          last_login_at: now,
        },
      ],
    };
  else if (path.endsWith("/audit-events/"))
    data = {
      results: [
        {
          id: "audit-1",
          created_at: now,
          actor: "person-1",
          actor_detail: people[0],
          action: "CREATE",
          resource_type: "REPORT",
          resource_id: "report-1",
          metadata: { title: "科研周报" },
        },
      ],
    };
  else if (path.endsWith("/account-provisioning/options/")) data = provisioning;
  else if (path.endsWith("/settings/")) data = settings;
  else if (path.endsWith("/integrations/health/")) data = { results: [] };
  else if (path.endsWith("/integrations/")) data = { results: [] };
  return { data, status: 200, statusText: "OK", headers: {}, config: { headers: new AxiosHeaders() } };
};
// Preview controls cannot create, update, or delete persistent records.
APIService.prototype.post = async () => {
  throw new Error("Read-only fixture");
};
APIService.prototype.patch = async () => {
  throw new Error("Read-only fixture");
};
APIService.prototype.delete = async () => {
  throw new Error("Read-only fixture");
};

const screens = {
  members: <ResearchChainDetail workspaceSlug={workspaceSlug} chainId="chain-1" />,
  org: <ResearchOrgTreeEditor workspaceSlug={workspaceSlug} />,
  templates: <ResearchTemplateList workspaceSlug={workspaceSlug} />,
  identity: <ResearchIdentityMappingTable workspaceSlug={workspaceSlug} />,
  audit: <ResearchAuditEventTable workspaceSlug={workspaceSlug} />,
  invites: (
    <div className="h-full overflow-auto p-5">
      <ResearchInviteCodeManager workspaceSlug={workspaceSlug} />
    </div>
  ),
  imports: (
    <div className="h-full overflow-auto p-5">
      <ResearchUserImportPanel workspaceSlug={workspaceSlug} />
    </div>
  ),
  platform: <ResearchPlatformSettingsForm workspaceSlug={workspaceSlug} />,
  integrations: <IntegrationSettings workspaceSlug={workspaceSlug} />,
  feedback: <FeedbackDialog workspaceSlug={workspaceSlug} managementOnly />,
};
const requested = new URLSearchParams(window.location.search).get("screen") ?? "members";
const screen = requested in screens ? screens[requested as keyof typeof screens] : screens.members;
await initPromise;
await store.research.fetchIdentity(workspaceSlug);
createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <TranslationProvider>
      <MemoryRouter initialEntries={["/sample/research/chains/chain-1?tab=members"]}>
        <main className="h-screen min-w-0 overflow-hidden bg-canvas">{screen}</main>
      </MemoryRouter>
    </TranslationProvider>
  </StoreProvider>
);
