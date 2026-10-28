// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TPeriodicReport } from "@plane/types";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  reports: {} as Record<string, TPeriodicReport>,
  fetchReport: vi.fn(),
  fetchReports: vi.fn(),
  fetchReportHistory: vi.fn(),
  withdrawReport: vi.fn(),
  setToast: vi.fn(),
}));

vi.mock("react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, string | number> = {}) => {
      const template = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      if (typeof template !== "string") return key;
      return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ""));
    },
    currentLocale: "zh-CN",
  }),
}));
vi.mock("@plane/propel/button", () => ({
  Button: ({ children, loading, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { SUCCESS: "success", ERROR: "error" },
  setToast: mocks.setToast,
}));
vi.mock("@plane/ui", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  ModalCore: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
}));
vi.mock("@plane/utils", () => ({ copyTextToClipboard: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/hooks/store/use-workspace", () => ({
  useWorkspace: () => ({ getWorkspaceBySlug: () => ({ id: "workspace-1" }) }),
}));
vi.mock("@/hooks/store/use-research", () => ({
  useResearch: () => ({
    reports: mocks.reports,
    reportHistory: {
      "report-1": [
        {
          id: "history-1",
          report: "report-1",
          actor: "student-1",
          action: "REOPEN" as const,
          from_status: "SUBMITTED" as const,
          to_status: "DRAFT" as const,
          comment: "补充实验参数",
          snapshot_version: "1",
          created_at: "2026-10-26T03:00:00Z",
        },
      ],
    },
    identity: { user: { id: "student-1" } },
    fetchReport: mocks.fetchReport,
    fetchReports: mocks.fetchReports,
    fetchReportHistory: mocks.fetchReportHistory,
    withdrawReport: mocks.withdrawReport,
  }),
}));
vi.mock("@/components/research/common/research-data-surface", () => ({
  ResearchDetailHeader: ({ actions }: { actions: React.ReactNode }) => <header>{actions}</header>,
  ResearchDetailSurface: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));
vi.mock("@/components/research/reports/report-body", () => ({
  ReportBody: React.forwardRef(function ReportBody(_props: unknown, ref: React.Ref<unknown>) {
    React.useImperativeHandle(ref, () => ({ save: async () => true }));
    return <section aria-label="正文" />;
  }),
}));
vi.mock("@/components/research/reports/report-attachments", () => ({
  ResearchReportAttachments: () => <section aria-label="附件" />,
}));
vi.mock("@/components/research/reports/report-comments", () => ({
  ResearchReportComments: () => <aside aria-label="讨论" />,
  useResearchReportCommentsPanel: () => ({ open: false, setOpen: vi.fn(), openForDiscussion: vi.fn() }),
}));

const { ResearchReportDetail } = await import("@/components/research/reports/report-detail");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let updateReportAfterFetch = false;

/** 渲染一份可撤回的已提交报告详情。 */
async function renderDetail() {
  await act(async () => root.render(<ResearchReportDetail workspaceSlug="lab" reportId="report-1" />));
}

function button(label: string) {
  const target = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === label);
  if (!target) throw new Error(`未找到按钮：${label}`);
  return target;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.reports = {
    "report-1": {
      id: "report-1",
      workspace: "workspace-1",
      project: null,
      team_projects: [],
      owner: "student-1",
      page: "page-1",
      page_project: null,
      template: null,
      report_type: "WEEKLY",
      period_key: "2026-W40",
      period_start: "2026-09-28",
      period_end: "2026-10-04",
      timezone: "Asia/Shanghai",
      status: "SUBMITTED",
      visibility: "PRIVATE",
      is_backfill: false,
      submitted_at: "2026-10-26T02:00:00Z",
      accepted_at: null,
      reviewer: null,
      created_at: "2026-10-25T00:00:00Z",
      updated_at: "2026-10-26T02:00:00Z",
      can_withdraw: true,
      latest_official_version: 1,
      official_content: null,
      draft_content: null,
    } as TPeriodicReport,
  };
  mocks.fetchReport.mockImplementation(async () => {
    if (!updateReportAfterFetch) return;
    mocks.reports["report-1"] = {
      ...mocks.reports["report-1"],
      status: "DRAFT",
      submitted_at: null,
      can_withdraw: false,
      can_edit: true,
    };
  });
  mocks.fetchReports.mockResolvedValue(undefined);
  mocks.fetchReportHistory.mockResolvedValue(undefined);
  updateReportAfterFetch = false;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

it("作者确认撤回后回到草稿并刷新详情、列表和历史", async () => {
  mocks.withdrawReport.mockImplementationOnce(async () => {
    updateReportAfterFetch = true;
    return { id: "report-1", status: "DRAFT" };
  });
  await renderDetail();
  expect(container.textContent).toContain("撤回 · 已提交 → 草稿");

  await act(async () => button("撤回").click());
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain("撤回后回到草稿，可修改后重新提交。");
  const reason = container.querySelector<HTMLInputElement>("input[aria-label='撤回原因（选填）']");
  if (!reason) throw new Error("撤回原因输入未显示");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(reason, "补充实验参数");
    reason.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("确认").click());

  expect(mocks.withdrawReport).toHaveBeenCalledWith("lab", "report-1", "补充实验参数");
  expect(mocks.fetchReport).toHaveBeenCalledWith("lab", "report-1");
  expect(mocks.fetchReports).toHaveBeenCalledWith("lab");
  expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "报告已撤回" }));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(button("提交")).toBeInstanceOf(HTMLButtonElement);
});

it("撤回冲突时保留确认弹窗并显示状态错误", async () => {
  mocks.withdrawReport.mockRejectedValueOnce({ error_code: "report_state_conflict" });
  await renderDetail();

  await act(async () => button("撤回").click());
  await act(async () => button("确认").click());

  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(container.textContent).toContain("当前报告状态不允许该操作。");
  expect(button("撤回")).toBeInstanceOf(HTMLButtonElement);
});
