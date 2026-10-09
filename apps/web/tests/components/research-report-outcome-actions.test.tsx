// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

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
  getReportTemplates: vi.fn(() => []),
  fetchReportTemplates: vi.fn().mockResolvedValue([]),
  templatesLoader: false,
  reportLoader: false,
  reportPaginationByWorkspace: {},
  identity: { user: { org_units: [{ org_unit: "unit-1", is_primary: true }] } },
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
vi.mock("react-router", () => ({
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => vi.fn(),
}));
vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({
    workspace: {
      fetchWorkspaceMembers: async () => undefined,
      getWorkspaceMemberIds: () => [],
    },
    getUserDetails: () => undefined,
  }),
}));
vi.mock("@/services/research/outcome.service", () => ({
  ResearchOutcomeService: class {
    getOutcomeAttachments() {
      return Promise.resolve({ results: [] });
    }
    presignOutcomeAttachment() {
      return Promise.resolve({ asset_id: "", upload_data: { url: "", fields: {} } });
    }
    registerOutcomeAttachment() {
      return Promise.resolve(null);
    }
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
  EModalPosition: { CENTER: "center" },
  EModalWidth: { LG: "lg" },
  /** 按弹窗开关渲染内容，保留报告创建入口的真实交互语义。 */
  ModalCore: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
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

describe("separate report and outcome actions", () => {
  it("keeps outcome registration on the project outcome surface without topic material upload", async () => {
    await act(async () => {
      root.render(<OutcomeList workspaceSlug="lab" projectId="project-1" />);
    });
    await act(async () => undefined);
    expect(container.textContent).toContain("登记成果");
    expect(container.textContent).not.toContain("上传课题资料");
    expect(container.textContent).not.toContain("opening.pdf");
    expect(container.textContent).not.toContain("课题资料");
  });

  it("keeps report creation as the only primary action on an empty report list", async () => {
    await act(async () => {
      root.render(<ResearchReportList workspaceSlug="lab" />);
    });
    await act(async () => undefined);
    expect(container.textContent).toContain("创建报告");
    expect(container.textContent).not.toContain("上传课题资料");
    expect(container.textContent).not.toContain("登记成果");
    expect(container.querySelector('a[href="/lab/research/projects/project-1/outcomes"]')).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });
});
