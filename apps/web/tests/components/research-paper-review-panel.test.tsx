// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  TResearchChainEvent,
  TResearchPaperReview,
  TResearchPaperReviewVersion,
  TResearchUserLite,
} from "@plane/types";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  getPaperReviews: vi.fn(),
  getPaperReview: vi.fn(),
  getPaperChainEvents: vi.fn(),
  uploadPaperVersion: vi.fn(),
  submitPaperVersion: vi.fn(),
  returnPaperVersion: vi.fn(),
  acceptPaperVersion: vi.fn(),
  withdrawPaperReview: vi.fn(),
  getPaperAssetUrl: vi.fn(),
}));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) => {
      const value = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      if (typeof value !== "string") return key;
      return value.replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name] ?? ""));
    },
    currentLocale: "zh-CN",
  }),
}));

vi.mock("@/services/research/paper-review.service", () => ({
  ResearchPaperReviewService: class {
    getPaperReviews = mocks.getPaperReviews;
    getPaperReview = mocks.getPaperReview;
    getPaperChainEvents = mocks.getPaperChainEvents;
    uploadPaperVersion = mocks.uploadPaperVersion;
    submitPaperVersion = mocks.submitPaperVersion;
    returnPaperVersion = mocks.returnPaperVersion;
    acceptPaperVersion = mocks.acceptPaperVersion;
    withdrawPaperReview = mocks.withdrawPaperReview;
    getPaperAssetUrl = mocks.getPaperAssetUrl;
  },
}));

const capability = (allowed: boolean) => ({ allowed, reason_code: "", reason: "" });

function user(displayName: string): TResearchUserLite {
  return {
    id: `${displayName}-id`,
    email: `${displayName}@example.com`,
    first_name: displayName,
    last_name: "",
    display_name: displayName,
    avatar: "",
    avatar_url: null,
    is_active: true,
  };
}

function version(overrides: Partial<TResearchPaperReviewVersion> = {}): TResearchPaperReviewVersion {
  return {
    schema_version: "research-paper-review-version.v1",
    id: "version-1",
    review: "review-1",
    version_no: 1,
    asset: "asset-1",
    asset_detail: {
      id: "asset-1",
      file_name: "paper-v1.pdf",
      content_type: "application/pdf",
      file_size: 2048,
    },
    file_name: "paper-v1.pdf",
    content_type: "application/pdf",
    file_size: 2048,
    change_summary: "提交初稿，补充方法部分。",
    status: "SUBMITTED",
    submitted_by: "student-1",
    submitted_by_detail: user("李同学"),
    submitted_at: "2026-10-09T08:00:00Z",
    content_hash: "hash-1",
    ...overrides,
  };
}

function review(overrides: Partial<TResearchPaperReview> = {}): TResearchPaperReview {
  return {
    schema_version: "research-paper-review.v1",
    id: "review-1",
    workspace: "ws",
    chain: "chain-1",
    node: "node-1",
    outcome: "outcome-1",
    owner: "student-1",
    owner_detail: user("李同学"),
    status: "NEEDS_REVISION",
    current_version_no: 1,
    final_reviewer: "advisor-1",
    final_reviewer_detail: user("王导师"),
    due_at: "2026-10-31T16:00:00Z",
    versions: [version({ status: "SUPERSEDED" })],
    capabilities: {
      schema_version: "research-capabilities.v1",
      actions: {
        view: capability(true),
        submit: capability(true),
        return: capability(false),
        accept: capability(false),
        withdraw: capability(true),
      },
    },
    created_at: "2026-10-08T08:00:00Z",
    updated_at: "2026-10-09T08:00:00Z",
    ...overrides,
  };
}

function event(event_type: string, overrides: Partial<TResearchChainEvent> = {}): TResearchChainEvent {
  return {
    schema_version: "research-event.v1",
    event_id: `${event_type}-event`,
    node: "node-1",
    actor: "advisor-1",
    actor_type: "USER",
    source_system: "PLANE",
    request_id: `request-${event_type}`,
    trace_id: "trace-1",
    event_type,
    occurred_at: "2026-10-09T09:00:00Z",
    refs: [
      { kind: "chain", id: "chain-1" },
      { kind: "node", id: "node-1" },
      { kind: "paper_review", id: "review-1" },
      { kind: "paper_version", id: "version-1", version_no: 1 },
    ],
    summary: `${event_type}: version 1`,
    content_hash: "event-hash",
    metadata: {},
    ...overrides,
  };
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal("crypto", {
    ...globalThis.crypto,
    subtle: {
      digest: async () => new ArrayBuffer(32),
    },
  });
  vi.spyOn(window, "open").mockImplementation(() => null);
  mocks.getPaperReviews.mockResolvedValue([review()]);
  mocks.getPaperReview.mockResolvedValue(review());
  mocks.getPaperChainEvents.mockResolvedValue([]);
  mocks.getPaperAssetUrl.mockResolvedValue("https://files.example/paper.pdf");
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

async function renderPanel(events: TResearchChainEvent[] = []) {
  const { ResearchPaperReviewPanel } = await import("@/components/research/chains/research-paper-review-panel");
  await act(async () => {
    root.render(<ResearchPaperReviewPanel workspaceSlug="lab" chainId="chain-1" nodeId="node-1" events={events} />);
  });
  await act(async () => undefined);
}

function button(label: string) {
  const buttons = [...container.querySelectorAll("button")];
  for (let index = buttons.length - 1; index >= 0; index -= 1) {
    if (buttons[index]?.textContent === label) return buttons[index];
  }
  throw new Error(`button ${label} not found`);
}

async function setInput(selector: string, value: string) {
  const input = container.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function chooseFile() {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["%PDF paper version 2"], "paper-v2.pdf", { type: "application/pdf" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new ArrayBuffer(32),
    configurable: true,
  });
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return file;
}

/** Simulate selecting multiple files in the single-version uploader. */
async function chooseMultipleFiles() {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const files = [
    new File(["first"], "first.pdf", { type: "application/pdf" }),
    new File(["second"], "second.pdf", { type: "application/pdf" }),
  ];
  await act(async () => {
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return files;
}

it("shows the author view, metadata, versions, file entries, and Chain Event comments", async () => {
  const chainEvents = [
    event("PAPER_REVIEW_OPENED", { event_id: "opened", refs: [{ kind: "paper_review", id: "other" }] }),
    event("PAPER_REVIEW_OPENED", { event_id: "opened-1" }),
    event("PAPER_REVIEW_RETURNED", {
      event_id: "returned-1",
      metadata: { comment: "补充第 3 节对照组说明。" },
    }),
  ];
  await renderPanel(chainEvents);

  expect(container.textContent).toContain("需修订");
  expect(container.textContent).toContain("王导师");
  expect(container.textContent).toContain("2026/11/1");
  expect(container.textContent).toContain("paper-v1.pdf");
  expect(container.textContent).toContain("提交初稿，补充方法部分。");
  expect(container.textContent).toContain("补充第 3 节对照组说明。");
  expect(container.textContent).toContain("Chain Event 评论串");
  expect(mocks.getPaperChainEvents).not.toHaveBeenCalled();
  expect(container.textContent).toContain("退回版本");
  expect(button("提交新版本")).not.toBeNull();
  expect(button("撤回")).not.toBeNull();
  expect([...container.querySelectorAll("button")].map((item) => item.textContent)).not.toContain("退回");
  expect([...container.querySelectorAll("button")].map((item) => item.textContent)).not.toContain("最终确认");

  await act(async () => button("打开文件").click());
  await act(async () => undefined);
  expect(mocks.getPaperAssetUrl).toHaveBeenCalledWith("lab", "asset-1");
});

it("shows the reviewer view and runs return, final confirmation, and withdrawal actions", async () => {
  const reviewerReview = review({
    status: "WAITING_REVIEW",
    capabilities: {
      schema_version: "research-capabilities.v1",
      actions: {
        view: capability(true),
        submit: capability(false),
        return: capability(true),
        accept: capability(true),
        withdraw: capability(false),
      },
    },
  });
  mocks.getPaperReview.mockResolvedValue(reviewerReview);
  mocks.getPaperReviews.mockResolvedValue([reviewerReview]);
  await renderPanel();

  expect(container.querySelector('input[type="file"]')).toBeNull();
  expect([...container.querySelectorAll("button")].map((item) => item.textContent)).not.toContain("撤回");

  await act(async () => button("退回").click());
  await act(async () => button("确认提交").click());
  expect(mocks.returnPaperVersion).not.toHaveBeenCalled();
  expect(container.textContent).toContain("请先填写原因。");

  await setInput("textarea", "请补充样本量说明。");
  mocks.returnPaperVersion.mockResolvedValueOnce(version());
  mocks.getPaperReview.mockResolvedValueOnce(
    review({
      status: "NEEDS_REVISION",
      capabilities: reviewerReview.capabilities,
    })
  );
  await act(async () => button("确认提交").click());
  await act(async () => undefined);
  expect(mocks.returnPaperVersion).toHaveBeenCalledWith("lab", "review-1", 1, {
    comment: "请补充样本量说明。",
  });
  expect(container.textContent).toContain("需修订");

  const waitingReview = review({
    status: "WAITING_REVIEW",
    capabilities: reviewerReview.capabilities,
  });
  mocks.getPaperReviews.mockResolvedValue([waitingReview]);
  mocks.getPaperReview.mockResolvedValue(waitingReview);
  await act(async () => button("刷新").click());
  await act(async () => undefined);
  await act(async () => button("最终确认").click());
  await setInput("textarea", "最终版本可以归档。");
  mocks.acceptPaperVersion.mockResolvedValueOnce(version({ status: "ACCEPTED" }));
  mocks.getPaperReview.mockResolvedValueOnce(
    review({
      status: "ACCEPTED",
      versions: [version({ status: "ACCEPTED" })],
      capabilities: reviewerReview.capabilities,
    })
  );
  await act(async () => button("确认提交").click());
  await act(async () => undefined);
  expect(mocks.acceptPaperVersion).toHaveBeenCalledWith("lab", "review-1", 1, {
    comment: "最终版本可以归档。",
  });
  expect(container.textContent).toContain("已确认");

  const ownerReview = review({
    status: "NEEDS_REVISION",
    capabilities: {
      schema_version: "research-capabilities.v1",
      actions: {
        view: capability(true),
        submit: capability(false),
        return: capability(false),
        accept: capability(false),
        withdraw: capability(true),
      },
    },
  });
  mocks.getPaperReviews.mockResolvedValue([ownerReview]);
  mocks.getPaperReview.mockResolvedValue(ownerReview);
  await act(async () => button("刷新").click());
  await act(async () => undefined);
  await act(async () => button("撤回").click());
  await setInput("textarea", "论文方向调整。");
  mocks.withdrawPaperReview.mockResolvedValueOnce(review({ status: "WITHDRAWN" }));
  await act(async () => button("确认提交").click());
  await act(async () => undefined);
  expect(mocks.withdrawPaperReview).toHaveBeenCalledWith("lab", "review-1", "论文方向调整。");
  expect(container.textContent).toContain("已撤回");
});

it("keeps the panel read-only when the server denies every action capability", async () => {
  const readOnlyReview = review({
    capabilities: {
      schema_version: "research-capabilities.v1",
      actions: {
        view: capability(true),
        submit: capability(false),
        return: capability(false),
        accept: capability(false),
        withdraw: capability(false),
      },
    },
  });
  mocks.getPaperReviews.mockResolvedValue([readOnlyReview]);
  mocks.getPaperReview.mockResolvedValue(readOnlyReview);
  await renderPanel();

  expect(container.textContent).toContain("需修订");
  expect(container.textContent).toContain("paper-v1.pdf");
  const labels = [...container.querySelectorAll("button")].map((item) => item.textContent);
  expect(labels).toContain("刷新");
  expect(labels).toContain("打开文件");
  expect(labels).not.toContain("提交新版本");
  expect(labels).not.toContain("退回");
  expect(labels).not.toContain("最终确认");
  expect(labels).not.toContain("撤回");
});

it("uploads a new immutable version and refreshes status, version list, and events", async () => {
  const first = review();
  const second = review({
    status: "WAITING_REVIEW",
    current_version_no: 2,
    versions: [
      version({
        id: "version-2",
        version_no: 2,
        asset: "asset-2",
        file_name: "paper-v2.pdf",
        change_summary: "补充退回意见对应的对照组说明。",
        submitted_at: "2026-10-10T08:00:00Z",
      }),
      version({ status: "SUPERSEDED" }),
    ],
  });
  mocks.getPaperReviews.mockResolvedValue([first]);
  mocks.getPaperReview.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  mocks.uploadPaperVersion.mockResolvedValueOnce("asset-2");
  mocks.submitPaperVersion.mockResolvedValueOnce(
    version({
      id: "version-2",
      version_no: 2,
      asset: "asset-2",
      file_name: "paper-v2.pdf",
      change_summary: "补充退回意见对应的对照组说明。",
    })
  );
  mocks.getPaperChainEvents.mockResolvedValueOnce([
    event("PAPER_VERSION_SUBMITTED", {
      event_id: "submitted-2",
      metadata: { comment: "补充退回意见对应的对照组说明。" },
    }),
  ]);
  await renderPanel([event("PAPER_REVIEW_RETURNED", { event_id: "returned-1" })]);

  const file = await chooseFile();
  await setInput("textarea", "补充退回意见对应的对照组说明。");
  await act(async () => button("提交新版本").click());
  await act(async () => undefined);

  expect(mocks.uploadPaperVersion).toHaveBeenCalledWith(
    "lab",
    "review-1",
    file,
    "0000000000000000000000000000000000000000000000000000000000000000"
  );
  expect(mocks.submitPaperVersion).toHaveBeenCalledWith("lab", "review-1", {
    asset_id: "asset-2",
    change_summary: "补充退回意见对应的对照组说明。",
  });
  expect(container.textContent).toContain("待评审");
  expect(container.textContent).toContain("paper-v2.pdf");
  expect(container.textContent).toContain("提交版本");
  expect((container.querySelector('input[type="file"]') as HTMLInputElement).value).toBe("");
});

it("keeps the form data and shows the server error when storage upload fails", async () => {
  mocks.uploadPaperVersion.mockRejectedValueOnce({ error: "对象存储暂不可用。" });
  await renderPanel();

  await chooseFile();
  await setInput("textarea", "尝试提交第二版。");
  await act(async () => button("提交新版本").click());
  await act(async () => undefined);

  expect(mocks.submitPaperVersion).not.toHaveBeenCalled();
  expect(container.textContent).toContain("对象存储暂不可用。");
  expect(container.textContent).toContain("尝试提交第二版。");
});

it("rejects a multi-file drop without setting a paper version", async () => {
  await renderPanel();
  await chooseMultipleFiles();
  await setInput("textarea", "批量文件不应提交。");
  await act(async () => button("提交新版本").click());
  await act(async () => undefined);

  expect(container.textContent).toContain("仅支持选择一个文件。");
  expect(mocks.uploadPaperVersion).not.toHaveBeenCalled();
  expect(mocks.submitPaperVersion).not.toHaveBeenCalled();
});

it("surfaces a server rejection without advancing the local review state", async () => {
  const reviewerReview = review({
    status: "WAITING_REVIEW",
    capabilities: {
      schema_version: "research-capabilities.v1",
      actions: {
        view: capability(true),
        submit: capability(false),
        return: capability(true),
        accept: capability(false),
        withdraw: capability(false),
      },
    },
  });
  mocks.getPaperReviews.mockResolvedValue([reviewerReview]);
  mocks.getPaperReview.mockResolvedValue(reviewerReview);
  mocks.returnPaperVersion.mockRejectedValueOnce({
    error_code: "research_permission_denied",
    error: "Only scientific reviewers can decide this paper version.",
  });
  await renderPanel();

  await act(async () => button("退回").click());
  await setInput("textarea", "补充统计检验说明。");
  await act(async () => button("确认提交").click());
  await act(async () => undefined);

  expect(container.textContent).toContain("Only scientific reviewers can decide this paper version.");
  expect(container.textContent).toContain("待评审");
});
