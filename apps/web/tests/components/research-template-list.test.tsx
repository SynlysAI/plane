// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TReportTemplate } from "@plane/types";

const mocks = vi.hoisted(() => ({
  fetchReportTemplates: vi.fn(),
  createReportTemplate: vi.fn(),
  updateReportTemplate: vi.fn(),
  deleteReportTemplate: vi.fn(),
}));

const template: TReportTemplate = {
  id: "template-1",
  scope: "REPORT",
  report_type: "WEEKLY",
  stage: "",
  material_type: "",
  name: "结构化周报模板",
  content_json: { type: "doc", content: [] },
  variables: [],
  sections_json: {
    version: 1,
    guidance: "按框架填写。",
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
  target_key: "REPORT:WEEKLY",
  is_default: true,
  is_active: true,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
};

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "research.templates.create": "新建模板",
        "research.templates.columns.name": "名称",
        "research.templates.columns.target": "适用对象",
        "research.templates.columns.sections": "章节数",
        "research.templates.columns.default": "默认",
        "research.templates.columns.status": "状态",
        "research.templates.columns.updated_at": "更新时间",
        "research.templates.editor_hint": "章节说明",
        "research.templates.guidance": "模板整体说明",
        "research.templates.sections": "模板章节",
        "research.templates.section_title": "章节标题",
        "research.templates.section_id": "章节 ID",
        "research.templates.section_guidance": "章节填写说明",
        "research.templates.required": "必填",
        "research.templates.max_chars": "字数上限",
        "research.templates.preview": "填写框架预览",
        "research.common.cancel": "取消",
        "research.common.save": "保存",
      })[key] ?? key,
    currentLocale: "zh-CN",
  }),
}));
vi.mock("@plane/propel/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@plane/propel/table", () => ({
  Table: ({ children }: { children: React.ReactNode }) => <table>{children}</table>,
  TableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody>,
  TableCell: ({ children }: { children: React.ReactNode }) => <td>{children}</td>,
  TableHead: ({ children }: { children: React.ReactNode }) => <th>{children}</th>,
  TableHeader: ({ children }: { children: React.ReactNode }) => <thead>{children}</thead>,
  TableRow: ({ children }: { children: React.ReactNode }) => <tr>{children}</tr>,
}));
vi.mock("@/components/research/common/error-messages", () => ({
  getResearchErrorKey: () => "research.errors.generic",
}));
vi.mock("@/components/research/common/research-data-surface", () => ({
  ResearchFilterToolbar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResearchListSurface: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResearchTableSurface: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/research/common/research-format", () => ({
  formatResearchDateTime: () => "2026-10-01",
}));
vi.mock("@/hooks/store/use-research", () => ({
  useResearch: () => ({
    getReportTemplates: () => [template],
    fetchReportTemplates: mocks.fetchReportTemplates,
    createReportTemplate: mocks.createReportTemplate,
    updateReportTemplate: mocks.updateReportTemplate,
    deleteReportTemplate: mocks.deleteReportTemplate,
  }),
}));

const { ResearchTemplateList } = await import("@/components/research/settings/templates/template-list");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** 通过可见文案获取按钮。 */
function button(label: string) {
  const element = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent === label);
  if (!element) throw new Error(`未找到按钮：${label}`);
  return element;
}

/** 通过可访问名称获取当前挂载的输入控件。 */
function control(label: string) {
  const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`未找到输入：${label}`);
  return element;
}

/** 修改原生输入控件的值并触发 React input 事件。 */
async function setInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.fetchReportTemplates.mockResolvedValue([template]);
  mocks.createReportTemplate.mockResolvedValue(template);
  mocks.updateReportTemplate.mockResolvedValue(template);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

it("模板设置页展示结构化模板并支持配置章节创建", async () => {
  await act(async () => root.render(<ResearchTemplateList workspaceSlug="lab" />));

  expect(container.textContent).toContain("结构化周报模板");
  expect(container.textContent).toContain("1");

  await act(async () => button("新建模板").click());
  await setInput(control("名称"), "月报结构化模板");
  await setInput(control("模板整体说明"), "按月度成果框架填写。");
  await setInput(control("章节标题"), "本月成果");
  await setInput(control("章节 ID"), "monthly-results");
  await setInput(control("章节填写说明"), "请填写本月成果、数据与实验小结。");
  await setInput(control("字数上限"), "300");
  await act(async () => button("保存").click());

  expect(mocks.createReportTemplate).toHaveBeenCalledWith("lab", {
    name: "月报结构化模板",
    scope: "REPORT",
    report_type: "WEEKLY",
    stage: "",
    material_type: "",
    is_default: false,
    is_active: true,
    sections_json: {
      version: 1,
      guidance: "按月度成果框架填写。",
      sections: [
        {
          id: "monthly-results",
          title: "本月成果",
          guidance: "请填写本月成果、数据与实验小结。",
          required: true,
          max_chars: 300,
        },
      ],
    },
  });
});
