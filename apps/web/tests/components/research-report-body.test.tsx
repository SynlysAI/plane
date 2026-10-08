// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TPeriodicReport } from "@plane/types";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  reports: {} as Record<string, TPeriodicReport>,
  reportHistory: {},
  settings: {},
  identity: { user: { id: "student-1" } },
  saveReportDraft: vi.fn(),
  importReportMarkdown: vi.fn(),
  fetchReport: vi.fn(),
  fetchReportHistory: vi.fn(),
  fetchReports: vi.fn(),
  submitReport: vi.fn(),
  updateReportVisibility: vi.fn(),
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks }));
vi.mock("@/hooks/store/use-workspace", () => ({
  useWorkspace: () => ({ getWorkspaceBySlug: () => ({ id: "workspace-1" }) }),
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key.split(".").reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations) ?? key,
    currentLocale: "zh-CN",
  }),
}));
vi.mock("@plane/propel/button", () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("@plane/propel/toast", () => ({ TOAST_TYPE: { SUCCESS: "success" }, setToast: vi.fn() }));
vi.mock("@plane/ui", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  ModalCore: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
}));
vi.mock("@/components/research/common/research-data-surface", () => ({
  ResearchDetailHeader: ({ title, actions }: { title: string; actions: React.ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {actions}
    </header>
  ),
  ResearchDetailSurface: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
}));
vi.mock("@/components/research/reports/report-attachments", () => ({
  ResearchReportAttachments: () => <section aria-label="附件" />,
}));
vi.mock("@/components/editor/document/editor", () => ({
  /** 用可编辑 DOM 与公开编辑器 API 隔离富文本依赖，保留正文变更行为。 */
  DocumentEditor: React.forwardRef(function Editor(
    {
      value,
      editable,
      onChange,
    }: {
      value: string | object;
      editable: boolean;
      onChange: (json: object, html: string) => void;
    },
    ref
  ) {
    const initial =
      typeof value === "string" ? value : String((value as { body?: string }).body ?? JSON.stringify(value));
    const [body, setBody] = React.useState(initial);
    React.useEffect(() => setBody(initial), [initial]);
    React.useImperativeHandle(
      ref,
      () => ({
        getDocument: () => ({ html: body, json: { type: "doc", body }, binary: new Uint8Array([1, 2]) }),
        getMarkDown: () => body,
        setEditorValueAtCursorPosition: (content: string) => {
          setBody((current) => current + content);
          onChange({ type: "doc", body: body + content }, body + content);
        },
      }),
      [body, onChange]
    );
    return (
      <textarea
        aria-label="正文编辑器"
        readOnly={!editable}
        value={body}
        onChange={(event) => {
          setBody(event.target.value);
          onChange({ type: "doc", body: event.target.value }, event.target.value);
        }}
      />
    );
  }),
}));

const { ResearchReportDetail } = await import("@/components/research/reports/report-detail");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** 创建项目关联或独立报告，供同一详情入口验证。 */
function report(projectBound = true): TPeriodicReport {
  return {
    id: "report-1",
    project: projectBound ? "project-1" : null,
    page_project: projectBound ? "project-1" : null,
    page: "page-1",
    owner: "student-1",
    report_type: "WEEKLY",
    period_key: "2026-W40",
    status: "DRAFT",
    visibility: "PRIVATE",
    can_edit: true,
    can_review: false,
    draft_content: { description_json: {}, description_html: "<p>服务器正文</p>", description_stripped: "服务器正文" },
    official_content: null,
  } as TPeriodicReport;
}

/** 返回当前可见的正文编辑器。 */
function editor(): HTMLTextAreaElement {
  const element = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="正文编辑器"]');
  if (!element) throw new Error("报告正文编辑器未显示");
  return element;
}

/** 通过用户输入事件修改正文并触发真实组件的未保存状态。 */
async function editBody(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(editor(), value);
    editor().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** 根据可见文案获取操作按钮。 */
function button(label: string): HTMLButtonElement {
  const element = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent === label);
  if (!element) throw new Error(`未找到按钮：${label}`);
  return element;
}

/** 触发指定文件输入框的用户选择事件。 */
async function pickFile(selector: string, file: File) {
  const input = container.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error("文件选择入口未显示");
  await act(async () => {
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** 建立可控的网络等待，用于验证上传及保存中的用户操作。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/** 从当前 store 渲染完整详情，让提交流程使用真实 ReportBody。 */
async function renderDetail() {
  await act(async () => root.render(<ResearchReportDetail workspaceSlug="lab" reportId="report-1" />));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.reports = { "report-1": report() };
  mocks.saveReportDraft.mockResolvedValue(undefined);
  mocks.fetchReport.mockResolvedValue(undefined);
  mocks.fetchReportHistory.mockResolvedValue(undefined);
  mocks.fetchReports.mockResolvedValue(undefined);
  mocks.submitReport.mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("报告详情正文保存与替换", () => {
  it.each([false, true])("项目关联为 %s 时在详情页直接编辑并保存同一正文", async (projectBound) => {
    mocks.reports["report-1"] = report(projectBound);
    await renderDetail();

    await editBody("<p>详情页修改</p>");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("未保存");
    await act(async () => button("保存").click());

    expect(mocks.saveReportDraft).toHaveBeenCalledWith("lab", "report-1", {
      description_html: "<p>详情页修改</p>",
      description_json: { type: "doc", body: "<p>详情页修改</p>" },
      description_binary: "AQI=",
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("已保存");
    expect(container.querySelector('a[href*="pages/page-1"]')).toBeNull();
  });

  it("保存失败保留本地正文并阻止提交，重试成功后再提交", async () => {
    mocks.reports["report-1"] = report(false);
    mocks.saveReportDraft.mockRejectedValue(new Error("upstream unavailable"));
    await renderDetail();
    await editBody("<p>失败后保留的本地正文</p>");

    await act(async () => button("提交").click());

    expect(mocks.submitReport).not.toHaveBeenCalled();
    expect(editor().value).toBe("<p>失败后保留的本地正文</p>");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("保存失败");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("本地内容已保留");

    mocks.saveReportDraft.mockResolvedValue(undefined);
    await act(async () => button("提交").click());
    expect(mocks.submitReport).toHaveBeenCalledWith("lab", "report-1");
  });

  it("后台刷新与保存失败均不覆盖未保存正文", async () => {
    mocks.reports["report-1"] = report(false);
    await renderDetail();
    await editBody("<p>本地未保存正文</p>");
    mocks.reports["report-1"] = {
      ...report(false),
      draft_content: {
        description_json: {},
        description_html: "<p>后台旧正文</p>",
        description_stripped: "后台旧正文",
      },
    };

    await renderDetail();

    expect(editor().value).toBe("<p>本地未保存正文</p>");
    mocks.saveReportDraft.mockRejectedValue(new Error("offline"));
    await act(async () => button("保存").click());
    await renderDetail();
    expect(editor().value).toBe("<p>本地未保存正文</p>");
  });

  it("保存期间新增正文保持未保存且首次提交不会冻结旧版本", async () => {
    const pendingSave = deferred<void>();
    mocks.saveReportDraft.mockReturnValue(pendingSave.promise);
    await renderDetail();
    await editBody("<p>保存开始时的正文</p>");
    await act(async () => button("提交").click());
    await editBody("<p>保存期间的新正文</p>");

    await act(async () => pendingSave.resolve());

    expect(editor().value).toBe("<p>保存期间的新正文</p>");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("未保存");
    expect(mocks.submitReport).not.toHaveBeenCalled();
  });

  it("未保存正文导入前需确认替换，取消保留本地，确认后展示新正文及相对图片提示", async () => {
    mocks.importReportMarkdown.mockImplementation(async () => {
      mocks.reports["report-1"] = {
        ...report(),
        draft_content: {
          description_json: {},
          description_html: '<h1>导入正文</h1><img src="https://example.com/remote.png">',
          description_stripped: "导入正文",
        },
      };
      return ["./images/local.png"];
    });
    const file = new File(["# 导入正文"], "weekly.md", { type: "text/markdown" });
    Object.defineProperty(file, "text", { value: async () => "# 导入正文" });
    await renderDetail();
    await editBody("<p>未保存修改</p>");
    await pickFile('input[accept=".md,.markdown"]', file);

    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("替换未保存正文");
    expect(mocks.importReportMarkdown).not.toHaveBeenCalled();
    await act(async () => button("取消").click());
    expect(editor().value).toBe("<p>未保存修改</p>");
    await pickFile('input[accept=".md,.markdown"]', file);
    await act(async () => button("替换正文").click());

    expect(editor().value).toContain("导入正文");
    expect(editor().value).toContain("https://example.com/remote.png");
    expect(editor().value).not.toContain("未保存修改");
    expect(container.textContent).toContain("./images/local.png");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("已保存");
  });

  it("Markdown 导入故障保留正文及确认框以便重试", async () => {
    mocks.importReportMarkdown.mockRejectedValue(new Error("upstream unavailable"));
    const file = new File(["# new"], "new.md", { type: "text/markdown" });
    Object.defineProperty(file, "text", { value: async () => "# new" });
    await renderDetail();
    await editBody("<p>导入失败前正文</p>");
    await pickFile('input[accept=".md,.markdown"]', file);

    await act(async () => button("替换正文").click());

    expect(editor().value).toBe("<p>导入失败前正文</p>");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Markdown 导入失败");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("图片直传及登记完成前禁用保存和提交，完成后插入正文", async () => {
    const prepare = deferred<{ ok: boolean; json: () => Promise<object> }>();
    const fetch = vi
      .fn()
      .mockReturnValueOnce(prepare.promise)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", fetch);
    await renderDetail();
    await pickFile(
      'input[accept="image/jpeg,image/png,image/webp,image/gif"]',
      new File(["PNG"], "image.png", { type: "image/png" })
    );

    expect(container.querySelector('[role="status"]')?.textContent).toBe("图片上传中");
    expect(button("保存").disabled).toBe(true);
    expect(button("提交").disabled).toBe(true);
    await act(async () => button("提交").click());
    expect(mocks.saveReportDraft).not.toHaveBeenCalled();
    expect(mocks.submitReport).not.toHaveBeenCalled();

    await act(async () => {
      prepare.resolve({
        ok: true,
        json: async () => ({ asset_id: "image-1", upload_data: { url: "https://s3.example/upload", fields: {} } }),
      });
    });

    expect(editor().value).toContain("/api/research/workspaces/lab/reports/report-1/images/image-1/");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("未保存");
    expect(button("保存").disabled).toBe(false);
    expect(button("提交").disabled).toBe(false);
  });
});
