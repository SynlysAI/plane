/** Uses the actual list components with an isolated, in-memory API. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { AxiosHeaders } from "axios";
import { TranslationProvider } from "@plane/i18n";
import { StoreProvider, store } from "@/lib/store-context";
import { APIService } from "@/services/api.service";
import { ResearchChainBoard } from "@/components/research/chains/research-chain-board";
import { ResearchReportList } from "@/components/research/reports/report-list";
// oxlint-disable-next-line import/no-unassigned-import -- shared fixture styles
import "./research-home-workbench.fixture.css";

const workspaceSlug = "sample";
const now = "2026-10-12T03:05:18Z";
const people = [
  { id: "person-1", display_name: "肖旭", email: "xiaoxu@example.org" },
  { id: "person-2", display_name: "李明", email: "liming@example.org" },
];
const units = [{ id: "group-1", name: "金属化", unit_type: "GROUP", is_active: true }];
const projects = [{ id: "project-1", name: "催化材料界面研究", research: { research_type: "RESEARCH_PROJECT" } }];
const chains = [
  {
    id: "chain-1",
    project: "project-1",
    project_name: "科研链功能测试",
    owner: "person-1",
    owner_name: "肖旭",
    status: "ACTIVE",
    visibility: "PRIVATE",
    org_unit: "group-1",
    research_type: "RESEARCH_PROJECT",
    current_node: { id: "node-1", title: "选题评估", status: "DRAFT" },
    open_task_count: 3,
    next_due_at: null,
    updated_at: now,
  },
  {
    id: "chain-2",
    project: "project-2",
    project_name: "高性能催化材料开发",
    owner: "person-2",
    owner_name: "李明",
    status: "ACTIVE",
    visibility: "ORG",
    org_unit: "group-1",
    research_type: "PHD",
    current_node: { id: "node-2", title: "实验数据分析", status: "WAITING_HUMAN" },
    open_task_count: 2,
    next_due_at: "2026-10-15",
    updated_at: now,
  },
];
const reports = [
  {
    id: "report-1",
    period_key: "2026-W42",
    report_type: "WEEKLY",
    owner: "person-1",
    owner_detail: people[0],
    org_unit: "group-1",
    org_unit_detail: units[0],
    status: "DRAFT",
    visibility: "DIRECT_ADVISOR",
    updated_at: now,
  },
  {
    id: "report-2",
    period_key: "2026-W41",
    report_type: "WEEKLY",
    owner: "person-2",
    owner_detail: people[1],
    org_unit: "group-1",
    org_unit_detail: units[0],
    status: "SUBMITTED",
    visibility: "UNIT",
    updated_at: now,
    has_read: true,
    read_count: 1,
    latest_read_at: now,
  },
];
const outcomes = [
  {
    id: "outcome-1",
    project: "project-1",
    title: "催化剂界面结构与活性关联",
    output_type: "PAPER",
    owner: "person-1",
    org_unit: "group-1",
    status: "DRAFT",
    venue: "",
    published_at: null,
    can_delete: false,
  },
  {
    id: "outcome-2",
    project: "project-1",
    title: "多孔复合材料制备方法",
    output_type: "PATENT",
    owner: "person-2",
    org_unit: "group-1",
    status: "PUBLISHED",
    venue: "",
    published_at: "2026-10-08",
    can_delete: false,
  },
];
const paginate = (results: unknown[]) => ({
  results,
  total_results: results.length,
  next_cursor: "",
  prev_cursor: "",
  next_page_results: false,
  prev_page_results: false,
});

function filterRecords<T extends object>(records: T[], params: Record<string, string>) {
  return records.filter((record) => {
    const fields = record as Record<string, unknown>;
    return Object.entries(params).every(([key, value]) => {
      if (!value) return true;
      if (key === "q") return JSON.stringify(record).toLowerCase().includes(value.toLowerCase());
      if (["status", "owner", "org_unit", "report_type", "period_key", "output_type", "research_type"].includes(key))
        return String(fields[key] ?? "").includes(value);
      return true;
    });
  });
}

// No fixture request reaches an actual workspace or writes persistent data.
APIService.prototype.get = async (rawUrl, options = {}) => {
  const url = new URL(rawUrl, window.location.origin);
  const params = {
    ...Object.fromEntries(url.searchParams),
    ...(options as { params?: Record<string, string> }).params,
  };
  const path = url.pathname;
  let data: unknown;
  if (path.endsWith("/members/"))
    data = people.map((member, index) => ({
      id: `membership-${index}`,
      member,
      role: 20,
      is_active: true,
      created_at: now,
    }));
  else if (path.endsWith("/me/"))
    data = {
      module_enabled: true,
      workspace_enabled: true,
      sections: { reports: true, research_chain: true },
      user: { id: "person-1", org_units: [{ org_unit: "group-1", is_primary: true }], mentor_ids: [], mentee_ids: [] },
    };
  else if (path.endsWith("/org-units/")) data = { results: units };
  else if (path.endsWith("/template-options/")) data = { results: [] };
  else if (path.endsWith("/projects/")) data = paginate(projects);
  else if (path.endsWith("/chains/")) data = paginate(filterRecords(chains, params));
  else if (path.endsWith("/reports/")) data = paginate(filterRecords(reports, params));
  else if (path.endsWith("/outcomes/"))
    data = { ...paginate(filterRecords(outcomes, params)), create_projects: projects };
  else throw new Error(`Unexpected fixture GET: ${path}`);
  return { data, status: 200, statusText: "OK", headers: {}, config: { headers: new AxiosHeaders() } };
};
APIService.prototype.post = async (rawUrl, payload = {}) => {
  const path = new URL(rawUrl, window.location.origin).pathname;
  const fields = payload as Record<string, string>;
  let data: unknown;
  if (path.endsWith("/reports/")) {
    const report = {
      ...reports[0],
      ...fields,
      id: `report-${reports.length + 1}`,
      period_key: fields.period_key || "2026-W43",
    };
    reports.unshift(report);
    data = report;
  } else if (path.endsWith("/outcomes/")) {
    const outcome = { ...outcomes[0], ...fields, id: `outcome-${outcomes.length + 1}` };
    outcomes.unshift(outcome);
    data = outcome;
  } else throw new Error(`Unexpected fixture POST: ${path}`);
  return { data, status: 201, statusText: "Created", headers: {}, config: { headers: new AxiosHeaders() } };
};

function Preview() {
  const navigate = useNavigate();
  const location = useLocation();
  const isChain = location.pathname.endsWith("/chains");
  return (
    <main className="flex h-screen min-w-0 flex-col overflow-hidden bg-canvas">
      <header className="shrink-0 border-b border-subtle bg-surface-1 px-5 py-4">
        <h1 className="text-18 font-semibold text-primary">科研项目</h1>
      </header>
      <nav aria-label="科研项目" className="flex shrink-0 gap-1 border-b border-subtle bg-surface-1 px-5 py-2">
        {[
          ["/sample/research/chains", "课题"],
          ["/sample/research/reports", "报告与成果"],
        ].map(([path, label]) => (
          <button
            key={path}
            aria-current={isChain === path.endsWith("/chains") ? "page" : undefined}
            className={`rounded-md px-3 py-2 text-13 ${isChain === path.endsWith("/chains") ? "bg-surface-2 font-medium text-primary" : "text-secondary"}`}
            onClick={() => navigate(path)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 min-w-0 flex-1">
        {isChain ? (
          <ResearchChainBoard workspaceSlug={workspaceSlug} />
        ) : (
          <ResearchReportList workspaceSlug={workspaceSlug} />
        )}
      </div>
    </main>
  );
}

await store.research.fetchIdentity(workspaceSlug);
createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <TranslationProvider>
      <MemoryRouter initialEntries={["/sample/research/chains"]}>
        <Preview />
      </MemoryRouter>
    </TranslationProvider>
  </StoreProvider>
);
