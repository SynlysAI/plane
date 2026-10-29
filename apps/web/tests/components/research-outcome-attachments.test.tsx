// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  presign: vi.fn(),
  register: vi.fn(),
  deleteAttachment: vi.fn(),
  fetchOutcomes: vi.fn(),
}));

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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
vi.mock("@plane/ui", () => ({
  ListFilterField: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ListFilterInput: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  ListFilterSelect: (props: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} />,
}));
vi.mock("@/components/research/common/research-data-surface", () => ({
  ResearchFilterToolbar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResearchListSurface: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResearchTableSurface: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/research/common/research-status-badge", () => ({
  ResearchStatusBadge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/research/common/research-delete-button", () => ({
  ResearchDeleteButton: () => null,
}));
vi.mock("@/hooks/store/use-research", () => ({
  useResearch: () => ({
    getOutcomes: () => [
      {
        id: "outcome-1",
        title: "Graphite paper",
        output_type: "PAPER",
        status: "DRAFT",
        venue: "Nature",
        links: [],
        attachments: [],
        can_delete: true,
      },
    ],
    fetchOutcomes: mocks.fetchOutcomes,
    createOutcome: vi.fn(),
    updateOutcome: vi.fn(),
    deleteOutcome: vi.fn(),
    chainExportUrl: vi.fn(() => "/export"),
  }),
}));
vi.mock("@/services/research/outcome.service", () => ({
  ResearchOutcomeService: class {
    presignOutcomeAttachment = mocks.presign;
    registerOutcomeAttachment = mocks.register;
    deleteOutcomeAttachment = mocks.deleteAttachment;
  },
}));

const { OutcomeList } = await import("@/components/research/outcomes/outcome-list");

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.presign.mockImplementation(async (_slug: string, _id: string, payload: { file_name: string }) => ({
    asset_id: `asset-${payload.file_name}`,
    upload_data: { url: "https://storage.example/upload", fields: { key: "value" } },
  }));
  mocks.register.mockResolvedValue(undefined);
  mocks.fetchOutcomes.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("uploads a flattened batch to one draft outcome and refreshes once", async () => {
  await act(async () => root.render(<OutcomeList workspaceSlug="lab" projectId="project-1" />));
  await act(async () => await Promise.resolve());

  const files = [
    new File(["first"], "first.pdf", { type: "application/pdf" }),
    new File(["second"], "second.pdf", { type: "application/pdf" }),
  ];
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("成果上传入口未显示");
    Object.defineProperty(input, "files", { configurable: true, value: files });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => await Promise.resolve());

  expect(mocks.presign).toHaveBeenCalledTimes(2);
  expect(mocks.register).toHaveBeenCalledWith("lab", "outcome-1", "asset-first.pdf");
  expect(mocks.register).toHaveBeenCalledWith("lab", "outcome-1", "asset-second.pdf");
  // One call comes from the initial list load and one from the completed batch.
  expect(mocks.fetchOutcomes).toHaveBeenCalledTimes(2);
});
