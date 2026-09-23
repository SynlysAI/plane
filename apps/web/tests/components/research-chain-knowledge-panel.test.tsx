// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  getKnowledgeBases: vi.fn(),
  uploadKnowledgeFile: vi.fn(),
  getKnowledgeUpload: vi.fn(),
  confirmKnowledgeReference: vi.fn(),
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
  }),
}));
vi.mock("@/services/research/chain.service", () => ({
  ResearchChainService: class {
    getKnowledgeBases = mocks.getKnowledgeBases;
    uploadKnowledgeFile = mocks.uploadKnowledgeFile;
    getKnowledgeUpload = mocks.getKnowledgeUpload;
    confirmKnowledgeReference = mocks.confirmKnowledgeReference;
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.getKnowledgeBases.mockResolvedValue({
    items: [{ external_id: "kb-1", title: "Materials" }],
    degraded: false,
  });
  mocks.uploadKnowledgeFile.mockResolvedValue({
    data: {
      id: "upload-1",
      status: "PENDING",
      knowledge_id: "knowledge-1",
      knowledge_base_id: "kb-1",
      file_name: "paper.md",
      error_code: "",
    },
  });
});

afterEach(() => {
  root.unmount();
  container.remove();
  vi.clearAllMocks();
});

it("selects a scoped knowledge base and uploads through the BFF", async () => {
  const { ResearchChainKnowledgePanel } = await import("@/components/research/chains/research-chain-knowledge-panel");
  await act(async () => {
    root.render(<ResearchChainKnowledgePanel workspaceSlug="lab" chainId="chain-1" nodeId="node-1" />);
  });
  await act(async () => undefined);

  const input = container.querySelector('input[type="file"]');
  expect(input).not.toBeNull();
  const file = new File(["# paper"], "paper.md", { type: "text/markdown" });
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file] });
    input?.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "通过 BFF 上传")?.click();
  });
  expect(mocks.uploadKnowledgeFile).toHaveBeenCalledWith(
    "lab",
    "chain-1",
    "node-1",
    "kb-1",
    expect.objectContaining({ name: "paper.md" })
  );
  expect(container.textContent).toContain("paper.md");
  expect(container.textContent).toContain("PENDING");
});
