// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  fetchIdentity: vi.fn(),
  fetchReportSummary: vi.fn(),
  getChains: vi.fn(),
  fetchProjects: vi.fn(),
  researchIdentity: {
    module_enabled: true,
    workspace_enabled: true,
    sections: { research_chain: true, reports: true },
    capabilities: { nav: ["research_chain", "summary"] },
    user: { id: "student-1", is_workspace_admin: false, org_units: [] },
  },
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const literal = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      const text = typeof literal === "string" ? literal : key;
      if (!values) return text;
      return Object.entries(values).reduce(
        (result, [name, value]) => result.replaceAll(`{${name}}`, String(value)),
        text
      );
    },
    currentLocale: "zh-CN",
  }),
}));
vi.mock("@plane/propel/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@/hooks/store/use-research", () => {
  const researchStore = {
    identity: mocks.researchIdentity,
    identityWorkspaceSlug: "lab",
    canSee: (key: string) => ["research_chain", "summary"].includes(key),
    fetchIdentity: mocks.fetchIdentity,
    fetchReportSummary: mocks.fetchReportSummary,
  };
  return { useResearch: () => researchStore };
});
vi.mock("@/hooks/store/use-project", () => {
  const projectStore = { fetchProjects: mocks.fetchProjects };
  return { useProject: () => projectStore };
});
vi.mock("@/services/research/chain.service", () => ({
  ResearchChainService: class {
    getChains = mocks.getChains;
  },
}));
vi.mock("@/components/research/common/research-todo-index", () => ({
  ResearchTodoEnvelopeList: () => <section aria-label="跨组件待办">待办动态</section>,
}));
vi.mock("@/components/home/widgets/recents", () => ({
  RecentActivityWidget: () => <section aria-label="最近动态">最近动态</section>,
}));

const { WorkspaceHomeWorkbench } = await import("@/components/home/workbench");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function project(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "admin-project",
    name: "设备采购协作",
    identifier: "PROC",
    archived_at: null,
    is_research_project: false,
    updated_at: "2026-10-08T08:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.fetchIdentity.mockResolvedValue(null);
  mocks.getChains.mockResolvedValue([
    {
      id: "chain-1",
      project: "research-project",
      project_name: "催化剂失活机理研究",
      owner: "student-1",
      owner_name: "学生一",
      status: "ACTIVE",
      visibility: "ORG",
      updated_at: "2026-10-09T08:00:00Z",
      open_task_count: 2,
      next_due_at: "2026-10-12T09:00:00Z",
      current_node: {
        id: "node-1",
        title: "实验数据分析",
        status: "WAITING_HUMAN",
        node_type: "ANALYSIS",
        updated_at: "2026-10-09T07:00:00Z",
      },
    },
  ]);
  mocks.fetchProjects.mockResolvedValue([
    project(),
    project({ id: "research-project", name: "科研项目内部 Project", is_research_project: true }),
  ]);
  mocks.fetchReportSummary.mockResolvedValue({
    period_key: "2026-W41",
    period_start: "2026-10-05",
    period_end: "2026-10-11",
    counts: { not_submitted: 3, draft: 1, submitted: 5, needs_revision: 2, accepted: 8 },
  });
  mocks.researchIdentity.module_enabled = true;
  mocks.researchIdentity.workspace_enabled = true;
  mocks.researchIdentity.sections.research_chain = true;
  mocks.researchIdentity.sections.reports = true;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

it("renders the fixed two-column home information architecture without generic widgets", async () => {
  await act(async () => root.render(<WorkspaceHomeWorkbench workspaceSlug="lab" />));
  await act(async () => undefined);

  const columns = container.querySelector("[data-testid='workspace-home-columns']");
  expect(columns?.className).toContain("min-w-0");
  expect(columns?.className).toContain("grid-cols-1");
  expect(columns?.className).toContain("xl:grid-cols-2");
  for (const title of ["科研项目概览", "行政项目概览", "待办动态", "最近动态", "报告提交摘要"]) {
    expect(container.textContent).toContain(title);
  }
  expect(container.textContent).not.toContain("快捷入口");
  expect(container.textContent).not.toContain("我的工作");
  expect(container.textContent).not.toContain("便签");
  expect(container.textContent).not.toContain("草稿");
});

it("keeps research and administrative project summaries separate", async () => {
  await act(async () => root.render(<WorkspaceHomeWorkbench workspaceSlug="lab" />));
  await act(async () => undefined);

  expect(container.textContent).toContain("催化剂失活机理研究");
  expect(container.textContent).toContain("实验数据分析");
  expect(container.textContent).toContain("2 项待办");
  expect(container.textContent).toContain("设备采购协作");
  expect(container.textContent).not.toContain("科研项目内部 Project");
  expect(mocks.getChains).toHaveBeenCalledTimes(1);
  expect(mocks.fetchProjects).toHaveBeenCalledTimes(1);
});

it("shows the compact report submission summary and refreshes the workbench", async () => {
  await act(async () => root.render(<WorkspaceHomeWorkbench workspaceSlug="lab" />));
  await act(async () => undefined);

  expect(container.textContent).toContain("2026-W41");
  for (const label of ["未提交3", "需修改2", "已验收8"]) {
    expect(container.textContent).toContain(label);
  }

  const refresh = [...container.querySelectorAll("button")].find((button) => button.textContent === "刷新");
  await act(async () => refresh?.click());
  expect(mocks.getChains).toHaveBeenCalledTimes(2);
  expect(mocks.fetchProjects).toHaveBeenCalledTimes(2);
  expect(mocks.fetchReportSummary).toHaveBeenCalledTimes(2);
});

it("uses a neutral research empty state when the caller has no research access", async () => {
  mocks.researchIdentity.sections.research_chain = false;
  vi.mocked(mocks.getChains).mockRejectedValue({ error_code: "research_permission_denied" });
  await act(async () => root.render(<WorkspaceHomeWorkbench workspaceSlug="lab" />));
  await act(async () => undefined);

  expect(container.textContent).toContain("当前账号没有科研数据访问权限。");
  expect(container.textContent).toContain("设备采购协作");
  expect(container.textContent).not.toContain("催化剂失活机理研究");
});
