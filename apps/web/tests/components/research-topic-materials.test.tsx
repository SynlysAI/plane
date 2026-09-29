// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const service = vi.hoisted(() => ({
  listTopicMaterials: vi.fn(),
  presignTopicMaterial: vi.fn(),
  confirmTopicMaterial: vi.fn(),
}));
const research = vi.hoisted(() => ({
  getOutcomes: vi.fn(() => []),
  fetchOutcomes: vi.fn().mockResolvedValue([]),
  createOutcome: vi.fn(),
  updateOutcome: vi.fn(),
  chainExportUrl: () => "/export",
  getReports: vi.fn(() => []),
  getOrgUnits: vi.fn(() => []),
  getResearchProjects: vi.fn(() => [
    { id: "project-1", name: "课题甲", research: { research_type: "RESEARCH_PROJECT" } },
  ]),
  fetchReports: vi.fn().mockResolvedValue([]),
  fetchOrgUnits: vi.fn().mockResolvedValue([]),
  fetchResearchProjects: vi.fn().mockResolvedValue([]),
  reportLoader: false,
  reportPaginationByWorkspace: {},
  identity: { user: { org_units: [] } },
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("react-router", () => ({ useParams: () => ({}) }));
vi.mock("@/services/research/outcome.service", () => ({
  ResearchOutcomeService: class {
    listTopicMaterials = service.listTopicMaterials;
    presignTopicMaterial = service.presignTopicMaterial;
    confirmTopicMaterial = service.confirmTopicMaterial;
  },
}));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => research }));
vi.mock("@/components/research/common/research-status-badge", () => ({
  ResearchStatusBadge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const value = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      if (typeof value !== "string") return key;
      return value.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ""));
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
vi.mock("@plane/propel/toast", () => ({ TOAST_TYPE: {}, setToast: vi.fn() }));
vi.mock("@plane/ui", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
vi.mock("@plane/propel/table", () => ({
  Table: ({ children }: { children?: React.ReactNode }) => <table>{children}</table>,
  TableHeader: ({ children }: { children?: React.ReactNode }) => <thead>{children}</thead>,
  TableBody: ({ children }: { children?: React.ReactNode }) => <tbody>{children}</tbody>,
  TableRow: ({ children }: { children?: React.ReactNode }) => <tr>{children}</tr>,
  TableHead: ({ children }: { children?: React.ReactNode }) => <th>{children}</th>,
  TableCell: ({ children }: { children?: React.ReactNode }) => <td>{children}</td>,
}));

import { OutcomeList } from "@/components/research/outcomes/outcome-list";
import { ResearchReportList } from "@/components/research/reports/report-list";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

const saved = [
  {
    id: "file-1",
    file_name: "opening.pdf",
    content_type: "application/pdf",
    size: 8,
    project: "project-1",
    project_name: "课题甲",
  },
  {
    id: "file-2",
    file_name: "notes.md",
    content_type: "text/markdown",
    size: 4,
    project: "project-1",
    project_name: "课题甲",
  },
];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  service.listTopicMaterials.mockResolvedValue({ results: saved, count: saved.length });
  service.presignTopicMaterial.mockResolvedValue({
    asset_id: "asset-1",
    upload_data: { url: "https://upload.example", fields: { key: "k" } },
  });
  service.confirmTopicMaterial.mockResolvedValue(saved[0]);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("topic materials on empty report and outcome pages", () => {
  it("shows upload and outcome registration without requiring an outcome row", async () => {
    await act(async () => {
      root.render(<OutcomeList workspaceSlug="lab" projectId="project-1" />);
    });
    await act(async () => undefined);
    expect(container.textContent).toContain("上传课题资料");
    expect(container.textContent).toContain("登记成果");
    expect(container.textContent).toContain("opening.pdf");
    expect(container.textContent).toContain("课题甲");
    expect(service.listTopicMaterials).toHaveBeenCalledWith("lab", "project-1");

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["# notes"], "notes.md", { type: "text/markdown" });
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(service.presignTopicMaterial).toHaveBeenCalledWith("lab", "project-1", {
      file_name: "notes.md",
      content_type: "text/markdown",
      size: file.size,
    });
    expect(service.confirmTopicMaterial).toHaveBeenCalledWith("lab", "project-1", "asset-1");
  });

  it("keeps the same two actions on an empty report list and rejects other file types", async () => {
    await act(async () => {
      root.render(<ResearchReportList workspaceSlug="lab" />);
    });
    await act(async () => undefined);
    expect(container.textContent).toContain("上传课题资料");
    expect(container.textContent).toContain("登记成果");
    expect(container.querySelector('a[href="/lab/research/projects/project-1/outcomes"]')).not.toBeNull();

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["nope"], "notes.txt", { type: "text/plain" });
    await act(async () => {
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(service.presignTopicMaterial).not.toHaveBeenCalled();
    expect(container.textContent).toContain("只允许上传 PDF 和 Markdown。");
  });
});
