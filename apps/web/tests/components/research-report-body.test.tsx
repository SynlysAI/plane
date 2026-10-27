// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TPeriodicReport } from "@plane/types";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  selectionAnchor: {
    version: 1,
    block_id: "block-1",
    block_type: "paragraph",
    selected_text: "催化剂活性实验",
    prefix: "本周完成",
    suffix: "，结果稳定",
    start_offset: 4,
    end_offset: 11,
  },
  deleteReport: vi.fn(),
  editorMigrationUpdate: false,
  reports: {} as Record<string, TPeriodicReport>,
  reportHistory: {},
  settings: {},
  identity: { user: { id: "student-1" } },
  saveReportDraft: vi.fn(),
  importReportMarkdown: vi.fn(),
  fetchReport: vi.fn(),
  fetchReportHistory: vi.fn(),
  fetchReports: vi.fn(),
  markReportRead: vi.fn(),
  submitReport: vi.fn(),
  updateReportVisibility: vi.fn(),
  exportReportMarkdown: vi.fn(),
  copyTextToClipboard: vi.fn(),
  setToast: vi.fn(),
  commentsProps: {} as Record<string, unknown>,
}));

vi.mock("mobx-react", () => ({ enableStaticRendering: vi.fn(), observer: (component: unknown) => component }));
vi.mock("react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks }));
vi.mock("@/hooks/store/use-workspace", () => ({
  useWorkspace: () => ({ getWorkspaceBySlug: () => ({ id: "workspace-1" }) }),
}));
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
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { SUCCESS: "success", ERROR: "error" },
  setToast: mocks.setToast,
}));
vi.mock("@plane/utils", () => ({ copyTextToClipboard: mocks.copyTextToClipboard }));
vi.mock("@plane/ui", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  ModalCore: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
}));
vi.mock("@/components/research/common/research-data-surface", () => ({
  ResearchDetailHeader: ({
    title,
    metadata,
    actions,
  }: {
    title: string;
    metadata: React.ReactNode;
    actions: React.ReactNode;
  }) => (
    <header>
      <h1>{title}</h1>
      <div>{metadata}</div>
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
vi.mock("@/components/research/reports/report-comments", () => ({
  ResearchReportComments: (props: Record<string, unknown>) => {
    mocks.commentsProps = props;
    return (
      <aside aria-label="讨论">
        <button type="button" onClick={() => props.onCollapsedChange(true)}>
          模拟收起讨论
        </button>
      </aside>
    );
  },
  useResearchReportCommentsPanel: () => {
    const [open, setOpen] = React.useState(
      () => window.localStorage.getItem("research_report_comments_panel_open") !== "false"
    );
    React.useEffect(() => {
      window.localStorage.setItem("research_report_comments_panel_open", String(open));
    }, [open]);
    return { open, setOpen, openForDiscussion: () => setOpen(true) };
  },
}));
vi.mock("@/components/pages/editor/toolbar", () => ({
  PageToolbar: ({ editorRef }: { editorRef: unknown }) => {
    if (!editorRef) throw new Error("格式工具栏未收到可用编辑器实例");
    return <section aria-label="正文格式工具栏">格式工具栏</section>;
  },
}));
vi.mock("@/components/editor/document/editor", () => ({
  /** 用可编辑 DOM 与公开编辑器 API 隔离富文本依赖，保留正文变更行为。 */
  DocumentEditor: React.forwardRef(function Editor(
    {
      value,
      editable,
      onChange,
      onTransaction,
      onCommentAnchorClick,
      handleEditorReady,
    }: {
      value: string | object;
      editable: boolean;
      onChange: (json: object, html: string, options?: { isMigrationUpdate?: boolean }) => void;
      onTransaction?: () => void;
      onCommentAnchorClick?: (threadId: string) => void;
      handleEditorReady?: (ready: boolean) => void;
    },
    ref
  ) {
    const initial =
      typeof value === "string" ? value : String((value as { body?: string }).body ?? JSON.stringify(value));
    const [body, setBody] = React.useState(initial);
    React.useImperativeHandle(
      ref,
      () => ({
        getDocument: () => ({ html: body, json: { type: "doc", body }, binary: new Uint8Array([1, 2]) }),
        getMarkDown: () => body,
        getSelectionAnchor: () => mocks.selectionAnchor,
        setCommentAnchors: vi.fn(),
        focusCommentAnchor: vi.fn(() => true),
        setEditorValueAtCursorPosition: (content: string) => {
          setBody((current) => current + content);
          onChange({ type: "doc", body: body + content }, body + content);
        },
      }),
      [body, onChange]
    );
    React.useEffect(() => {
      if (mocks.editorMigrationUpdate) onChange({}, initial, { isMigrationUpdate: true });
    }, [initial, onChange]);
    React.useEffect(() => {
      handleEditorReady?.(true);
      return () => handleEditorReady?.(false);
    }, [handleEditorReady]);
    return (
      <div
        role="presentation"
        onClick={(event) => {
          const target = event.target as HTMLElement;
          const threadId = target.closest("[data-comment-thread-id]")?.getAttribute("data-comment-thread-id");
          if (threadId) onCommentAnchorClick?.(threadId);
        }}
        onKeyDown={() => undefined}
      >
        <textarea
          aria-label="正文编辑器"
          readOnly={!editable}
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
            onChange({ type: "doc", body: event.target.value }, event.target.value);
          }}
        />
        <button type="button" onClick={onTransaction}>
          触发选区
        </button>
        <span data-comment-thread-id="thread-1">正文批注锚点</span>
      </div>
    );
  }),
}));

const { ResearchReportDetail } = await import("@/components/research/reports/report-detail");
const { ReportBody } = await import("@/components/research/reports/report-body");

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
    template: "template-1",
    template_detail: {
      id: "template-1",
      name: "结构化周报模板",
      sections_json: {
        version: 1,
        guidance: "按研究进展框架填写。",
        sections: [
          {
            id: "progress",
            title: "本周进展",
            guidance: "请填写本周进展。",
            required: true,
            max_chars: 100,
          },
        ],
      },
    },
    owner: "student-1",
    owner_detail: { display_name: "学生一" },
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

it("报告正文显示模板章节引导和软性字数警告", async () => {
  await renderBody();

  expect(container.textContent).toContain("填写框架");
  expect(container.textContent).toContain("按研究进展框架填写。");
  expect(container.textContent).toContain("本周进展 *");
  expect(container.textContent).toContain("0 / 100");
  expect(container.textContent).toContain("必填章节尚未填写。");
});

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

/** 直接渲染正文，用于验证批注选区和锚点交互。 */
async function renderBody(props: Partial<React.ComponentProps<typeof ReportBody>> = {}) {
  await act(async () =>
    root.render(
      <ReportBody report={report()} workspaceSlug="lab" workspaceId="workspace-1" onBusy={vi.fn()} {...props} />
    )
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.reports = { "report-1": report() };
  mocks.editorMigrationUpdate = false;
  mocks.saveReportDraft.mockResolvedValue(undefined);
  mocks.fetchReport.mockResolvedValue(undefined);
  mocks.fetchReportHistory.mockResolvedValue(undefined);
  mocks.fetchReports.mockResolvedValue(undefined);
  mocks.submitReport.mockResolvedValue(undefined);
  mocks.markReportRead.mockResolvedValue(undefined);
  mocks.exportReportMarkdown.mockResolvedValue(new Blob(["ZIP"], { type: "application/zip" }));
  mocks.copyTextToClipboard.mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("报告详情正文保存与替换", () => {
  it("编辑态显示常驻格式工具栏和 slash 提示", async () => {
    await renderBody();

    expect(container.querySelector('[aria-label="正文格式工具栏"]')).not.toBeNull();
    expect(container.textContent).toContain("输入 “/” 可打开完整格式菜单");
  });

  it("只读正式版本不显示格式工具栏和 slash 提示", async () => {
    await renderBody({
      report: {
        ...report(),
        can_edit: false,
        draft_content: null,
        official_content: {
          version_no: 1,
          description_json: {},
          description_html: "<p>正式正文</p>",
          description_stripped: "正式正文",
        },
      },
    });

    expect(container.querySelector('[aria-label="正文格式工具栏"]')).toBeNull();
    expect(container.textContent).not.toContain("输入 “/” 可打开完整格式菜单");
  });

  it("正文加载中不显示格式工具栏", async () => {
    await renderBody({ report: { ...report(), draft_content: null, official_content: null } });

    expect(container.querySelector('textarea[aria-label="正文编辑器"]')).toBeNull();
    expect(container.querySelector('[aria-label="正文格式工具栏"]')).toBeNull();
  });

  it("记忆讨论栏收起状态并在正文发起批注时自动展开", async () => {
    vi.stubGlobal(
      "getSelection",
      vi.fn(() => ({
        rangeCount: 1,
        getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 100, top: 100 }) }),
      }))
    );
    await renderDetail();
    expect(mocks.commentsProps.collapsed).toBe(false);

    await act(async () => button("模拟收起讨论").click());
    expect(mocks.commentsProps.collapsed).toBe(true);
    expect(window.localStorage.getItem("research_report_comments_panel_open")).toBe("false");

    await act(async () => button("触发选区").click());
    await act(async () => button("批注选中文字").click());

    expect(mocks.commentsProps.collapsed).toBe(false);
    expect(window.localStorage.getItem("research_report_comments_panel_open")).toBe("true");
    expect((mocks.commentsProps.draftAnchor as { selected_text?: string })?.selected_text).toBe("催化剂活性实验");
  });

  it.each(["WEEKLY", "MONTHLY"] as const)("详情页元信息显示 %s 撰写人显示名", async (reportType) => {
    mocks.reports["report-1"] = {
      ...report(),
      report_type: reportType,
      owner_detail: {
        id: "student-1",
        email: "student@example.com",
        first_name: "三",
        last_name: "张",
        display_name: "张三",
        avatar: "",
        avatar_url: null,
        is_active: true,
      },
    };
    await renderDetail();

    expect(container.querySelector("header div")?.textContent).toContain("撰写人：张三");
  });

  it("撰写人详情缺失时回退显示责任人 ID", async () => {
    const fallbackReport = { ...report(), owner_detail: undefined };
    mocks.reports["report-1"] = fallbackReport;
    await renderDetail();

    expect(container.querySelector("header div")?.textContent).toContain("撰写人：student-1");
  });

  it("从列表缓存进入详情时等待正文，详情加载完成后展示已保存内容", async () => {
    mocks.reports["report-1"] = { ...report(), draft_content: null };
    await renderDetail();

    expect(container.querySelector('[role="status"]')?.textContent).toBe("加载中");
    expect(container.querySelector('textarea[aria-label="正文编辑器"]')).toBeNull();
    expect(button("保存").disabled).toBe(true);
    expect(button("提交").disabled).toBe(true);
    expect(mocks.saveReportDraft).not.toHaveBeenCalled();

    mocks.reports["report-1"] = report();
    await renderDetail();

    expect(editor().value).toBe("<p>服务器正文</p>");
    expect(button("保存").disabled).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("已保存");
  });

  it("未编辑时异步返回的最新正文会重新初始化编辑器", async () => {
    await renderDetail();
    mocks.reports["report-1"] = {
      ...report(),
      draft_content: {
        description_json: {},
        description_html: "<p>保存后的最新正文</p>",
        description_stripped: "保存后的最新正文",
      },
    };
    await renderDetail();

    expect(editor().value).toBe("<p>保存后的最新正文</p>");
  });

  it("编辑器初始化迁移不会把正文标记为未保存", async () => {
    mocks.editorMigrationUpdate = true;
    await renderDetail();

    expect(container.querySelector('[role="status"]')?.textContent).toBe("已保存");
  });

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

describe("周报 Markdown 导出与链接复制", () => {
  it("编辑态导出当前编辑器 Markdown 并下载 ZIP", async () => {
    const clickedAnchors: HTMLAnchorElement[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function mockClick(this: HTMLAnchorElement) {
        clickedAnchors.push(this);
      });
    const createObjectURL = vi.fn(() => "blob:report-zip");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    try {
      await renderDetail();
      await editBody("# 当前编辑内容\n\n![图](/api/research/workspaces/lab/reports/report-1/images/image-1/)");

      await act(async () => button("导出 Markdown").click());

      expect(mocks.exportReportMarkdown).toHaveBeenCalledWith(
        "lab",
        "report-1",
        "# 当前编辑内容\n\n![图](/api/research/workspaces/lab/reports/report-1/images/image-1/)"
      );
      expect(clickedAnchors).toHaveLength(1);
      expect(clickedAnchors[0].download).toBe("weekly-2026-W40.zip");
      expect(clickedAnchors[0].href).toBe("blob:report-zip");
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:report-zip");
    } finally {
      clickSpy.mockRestore();
    }
  });

  it("只读正式版本同样可以导出 Markdown ZIP", async () => {
    const official = report();
    Object.assign(official, {
      status: "ACCEPTED",
      can_edit: false,
      draft_content: null,
      official_content: {
        version_no: 2,
        description_json: {},
        description_html: "# 正式版本",
        description_stripped: "正式版本",
      },
    });
    mocks.reports["report-1"] = official;

    await renderDetail();
    await act(async () => button("导出 Markdown").click());

    expect(mocks.exportReportMarkdown).toHaveBeenCalledWith("lab", "report-1", "# 正式版本");
  });

  it("导出失败后保留正文并恢复按钮", async () => {
    mocks.exportReportMarkdown.mockRejectedValue(new Error("upstream unavailable"));
    await renderDetail();
    await editBody("# 需要保留的正文");

    await act(async () => button("导出 Markdown").click());

    expect(editor().value).toBe("# 需要保留的正文");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("周报导出失败");
    expect(button("导出 Markdown").disabled).toBe(false);
  });

  it("导出进行中禁用按钮并在完成后恢复", async () => {
    const pendingExport = deferred<Blob>();
    mocks.exportReportMarkdown.mockReturnValue(pendingExport.promise);
    await renderDetail();

    await act(async () => button("导出 Markdown").click());

    expect(button("导出 Markdown").disabled).toBe(true);
    await act(async () => pendingExport.resolve(new Blob(["ZIP"], { type: "application/zip" })));

    expect(button("导出 Markdown").disabled).toBe(false);
  });

  it("复制授权详情页完整链接并提示结果", async () => {
    const locationDescriptor = Object.getOwnPropertyDescriptor(window, "location");
    Object.defineProperty(window, "location", {
      value: { origin: "http://pilab.local" },
      configurable: true,
    });
    try {
      await renderDetail();
      await act(async () => button("复制链接").click());

      expect(mocks.copyTextToClipboard).toHaveBeenCalledWith(
        "Plane 周报: 2026-W40 · 学生一 ( http://pilab.local/lab/research/reports/report-1 )"
      );
      expect(mocks.setToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "success", title: "分享内容已复制" })
      );
    } finally {
      if (locationDescriptor) Object.defineProperty(window, "location", locationDescriptor);
    }
  });

  it("剪贴板失败时显示错误提示", async () => {
    mocks.copyTextToClipboard.mockRejectedValue(new Error("denied"));
    await renderDetail();

    await act(async () => button("复制链接").click());

    expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });
});

describe("报告详情已读回执", () => {
  it("非作者打开正式版本后自动上报一次", async () => {
    const official = report();
    Object.assign(official, {
      owner: "advisor-1",
      status: "SUBMITTED",
      can_edit: false,
      can_review: true,
      draft_content: null,
      official_content: {
        version_no: 1,
        description_json: {},
        description_html: "<p>正式正文</p>",
        description_stripped: "正式正文",
      },
      has_read: false,
      read_count: 0,
      latest_read_at: null,
    });
    mocks.reports["report-1"] = official;

    await renderDetail();
    await act(async () => undefined);

    expect(mocks.markReportRead).toHaveBeenCalledTimes(1);
    expect(mocks.markReportRead).toHaveBeenCalledWith("lab", "report-1");
  });

  it("作者和未返回正式版本的报告不上报已读", async () => {
    mocks.reports["report-1"] = report();
    await renderDetail();
    await act(async () => undefined);
    expect(mocks.markReportRead).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    root = createRoot(container);
    const submittedByAuthor = report();
    Object.assign(submittedByAuthor, {
      status: "SUBMITTED",
      can_edit: false,
      official_content: { version_no: 1, description_json: {}, description_html: "<p>正文</p>" },
    });
    mocks.reports["report-1"] = submittedByAuthor;
    await renderDetail();
    await act(async () => undefined);
    expect(mocks.markReportRead).not.toHaveBeenCalled();
  });
});

describe("报告正文批注交互", () => {
  it("选中文本后可把稳定锚点交给评论侧栏", async () => {
    const onCreateComment = vi.fn();
    vi.spyOn(window, "getSelection").mockReturnValue({
      rangeCount: 1,
      getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 100, top: 100 }) }),
    } as unknown as Selection);
    await renderBody({ onCreateComment });

    await act(async () => button("触发选区").click());
    await act(async () => button("批注选中文字").click());

    expect(onCreateComment).toHaveBeenCalledWith(mocks.selectionAnchor);
  });

  it("点击正文批注装饰会打开对应线程", async () => {
    const onCommentAnchorClick = vi.fn();
    await renderBody({ onCommentAnchorClick });
    const anchor = container.querySelector<HTMLElement>("[data-comment-thread-id]");

    await act(async () => anchor?.click());

    expect(onCommentAnchorClick).toHaveBeenCalledWith("thread-1");
  });
});
