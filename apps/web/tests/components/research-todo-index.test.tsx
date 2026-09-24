// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  research: { canSee: (key: string) => key !== "reviews" },
  reports: vi.fn(),
  reviews: vi.fn(),
  approvals: vi.fn(),
  chains: vi.fn(),
  chainNodes: vi.fn(),
  uploads: vi.fn(),
  connections: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const value = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      return typeof value === "string" ? value : key;
    },
  }),
}));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks.research }));
vi.mock("@/services/research/report.service", () => ({
  ResearchReportService: class {
    getReports = mocks.reports;
  },
}));
vi.mock("@/services/research/review.service", () => ({
  ResearchReviewService: class {
    getReviews = mocks.reviews;
  },
}));
vi.mock("@/services/research/approval.service", () => ({
  ResearchApprovalService: class {
    getApprovalRequests = mocks.approvals;
  },
}));
vi.mock("@/services/research/chain.service", () => ({
  ResearchChainService: class {
    getChains = mocks.chains;
    getChainNodes = mocks.chainNodes;
    getKnowledgeUploads = mocks.uploads;
  },
}));
vi.mock("@/services/research/integration.service", () => ({
  ResearchIntegrationService: class {
    getConnections = mocks.connections;
  },
}));

const { ResearchTodoIndex } = await import("@/components/research/common/research-todo-index");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.reports.mockResolvedValue({ results: [] });
  mocks.approvals.mockResolvedValue({ results: [] });
  mocks.reviews.mockResolvedValue({ results: [] });
  mocks.chains.mockResolvedValue([]);
  mocks.connections.mockResolvedValue({ results: [] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("aggregates authoritative sources and orders blocking items first", async () => {
  mocks.reports.mockResolvedValue({
    results: [
      {
        id: "report-1",
        period_key: "2026-W38",
        period_end: "2026-09-30T00:00:00Z",
        project: "project-1",
        owner: "user-1",
        updated_at: "2026-09-22T00:00:00Z",
      },
    ],
  });
  mocks.approvals.mockResolvedValue({
    results: [
      {
        id: "approval-1",
        status: "PENDING",
        issue_detail: { name: "采购超算机时" },
        requested_by: "user-2",
        created_at: "2026-09-23T00:00:00Z",
      },
    ],
  });

  await act(async () => root.render(<ResearchTodoIndex workspaceSlug="lab" />));

  const rows = [...container.querySelectorAll("li")];
  expect(rows[0]?.textContent).toContain("报告需修订 · 2026-W38");
  expect(rows[1]?.textContent).toContain("采购超算机时");
  expect(
    container.querySelector('a[href="/lab/research/chains?view=reports&status=NEEDS_REVISION&mine=true"]')
  ).not.toBeNull();
});

it("marks a non-success RAG upload as blocking without exposing payload JSON", async () => {
  mocks.chains.mockResolvedValue([
    { id: "chain-1", project: "chain", updated_at: "2026-09-23T00:00:00Z", status: "ACTIVE" },
  ]);
  mocks.chainNodes.mockResolvedValue([{ id: "node-1", updated_at: "2026-09-23T00:00:00Z" }]);
  mocks.uploads.mockResolvedValue({
    data: [
      {
        id: "upload-1",
        status: "FAILED",
        knowledge_id: "secret-knowledge",
        knowledge_base_id: "kb-1",
        file_name: "literature.pdf",
        error_code: "http_error",
      },
    ],
  });

  await act(async () => root.render(<ResearchTodoIndex workspaceSlug="lab" />));

  expect(container.textContent).toContain("literature.pdf");
  expect(container.textContent).toContain("阻断");
  expect(container.textContent).not.toContain("secret-knowledge");
  expect(container.textContent).not.toContain("http_error");
});
