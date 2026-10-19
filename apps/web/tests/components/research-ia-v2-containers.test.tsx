// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  view: "projects",
  iaV2: true,
  research: {
    identityWorkspaceSlug: "lab",
    identity: {
      user: { org_units: [] },
      sections: {
        reports: true,
        approvals: true,
        stages: true,
        research_chain: true,
      },
    },
    isIaV2Enabled: true,
    isWorkspaceAdmin: false,
    isResearchAdmin: false,
    canSee: (key: string) => key !== "reviews",
    getOrgUnits: () => [],
    fetchOrgUnits: async () => undefined,
  },
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(mocks.view ? `view=${mocks.view}` : "")],
}));
vi.mock("@plane/i18n", () => ({
  DEFAULT_LANGUAGE: "zh-CN",
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/research/approvals/approval-list", () => ({
  ResearchApprovalList: () => <div>office-approvals</div>,
}));
vi.mock("@/components/research/common/research-page-shell", () => ({
  ResearchPageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/research/common/research-todo-index", () => ({
  ResearchTodoEnvelopeList: () => <section aria-label="跨组件待办">shared-todos</section>,
}));
vi.mock("@/components/research/reports/report-list", () => ({
  ResearchReportList: () => <div>report-list</div>,
}));
vi.mock("@/components/research/reviews/review-inbox", () => ({
  ReviewInbox: () => <div>review-inbox</div>,
}));
vi.mock("@/components/research/chains/research-chain-board", () => ({
  ResearchChainBoard: () => <div>chain-board</div>,
}));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks.research }));
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: { id: "user-1" } }) }));

vi.mock("@/components/research/projects/research-project-list", () => ({ ResearchProjectList: () => <div>research-project-records</div> }));

const { ResearchApprovalCenter } = await import("@/components/research/approvals/research-approval-center");
const { ResearchChainWorkbench } = await import("@/components/research/chains/research-chain-workbench");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("renders the IA v2 approval queue with capability-filtered tabs", async () => {
  mocks.view = "";
  await act(async () => root.render(<ResearchApprovalCenter workspaceSlug="lab" />));

  expect(container.textContent).toContain("research.approvals.tabs.shared_todos");
  expect(container.textContent).toContain("research.approvals.tabs.report_review");
  expect(container.textContent).toContain("research.approvals.tabs.office");
  expect(container.textContent).not.toContain("research.approvals.tabs.stage_review");
  expect(container.textContent).toContain("shared-todos");
  expect(container.textContent).not.toContain("report-list");
});

it("keeps the office approval page when IA v2 is disabled", async () => {
  mocks.view = "";
  mocks.research.isIaV2Enabled = false;
  await act(async () => root.render(<ResearchApprovalCenter workspaceSlug="lab" />));
  mocks.research.isIaV2Enabled = true;

  expect(container.textContent).toContain("research.approvals.tabs.office");
  expect(container.textContent).toContain("shared-todos");
});

it("falls back the legacy project view to the chain list without embedding Project", async () => {
  mocks.view = "projects";
  await act(async () => root.render(<ResearchChainWorkbench workspaceSlug="lab" />));

  expect(container.textContent).toContain("research-project-records");
  expect(container.textContent).not.toContain("project-list");
  expect(container.textContent).not.toContain("research.chains.views.projects");

  mocks.research.isIaV2Enabled = false;
  await act(async () => root.render(<ResearchChainWorkbench key="ia-off" workspaceSlug="lab" />));
  expect(container.textContent).toContain("research-project-records");
});
