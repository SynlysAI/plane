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
      sections: {
        reports: true,
        approvals: true,
        stages: true,
        research_chain: true,
        research_agent: true,
      },
    },
    isIaV2Enabled: true,
    isWorkspaceAdmin: false,
    canSee: (key: string) => key !== "reviews",
  },
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("react-router", () => ({
  useSearchParams: () => [new URLSearchParams(mocks.view ? `view=${mocks.view}` : "")],
}));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/research/approvals/approval-list", () => ({
  ResearchApprovalList: () => <div>office-approvals</div>,
}));
vi.mock("@/components/research/common/research-page-shell", () => ({
  ResearchPageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
vi.mock("@/components/research/projects/research-project-list", () => ({
  ResearchProjectList: () => <div>project-list</div>,
}));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks.research }));
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: { id: "user-1" } }) }));

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

  expect(container.textContent).toContain("research.approvals.tabs.report_review");
  expect(container.textContent).toContain("research.approvals.tabs.agent_approval");
  expect(container.textContent).toContain("research.approvals.tabs.office");
  expect(container.textContent).not.toContain("research.approvals.tabs.stage_review");
  expect(container.textContent).toContain("report-list");
});

it("keeps the office approval page when IA v2 is disabled", async () => {
  mocks.view = "";
  mocks.research.isIaV2Enabled = false;
  await act(async () => root.render(<ResearchApprovalCenter workspaceSlug="lab" />));
  mocks.research.isIaV2Enabled = true;

  expect(container.textContent).not.toContain("research.approvals.tabs.office");
  expect(container.textContent).toContain("office-approvals");
});

it("embeds the legacy project list as a Research Chain saved view", async () => {
  mocks.view = "projects";
  await act(async () => root.render(<ResearchChainWorkbench workspaceSlug="lab" />));

  expect(container.textContent).toContain("project-list");
  expect(container.textContent).not.toContain("chain-board");

  mocks.research.isIaV2Enabled = false;
  await act(async () => root.render(<ResearchChainWorkbench key="ia-off" workspaceSlug="lab" />));
  expect(container.textContent).toContain("chain-board");
});
