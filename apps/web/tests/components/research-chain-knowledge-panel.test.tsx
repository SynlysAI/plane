// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  getKnowledgeBases: vi.fn(),
  getKnowledgeUploads: vi.fn(),
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
    getKnowledgeUploads = mocks.getKnowledgeUploads;
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
  mocks.getKnowledgeUploads.mockResolvedValue({ data: [] });
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
  expect((input as HTMLInputElement).value).toBe("");
  expect(container.textContent).toContain("paper.md");
  expect(container.textContent).toContain("PENDING");
});

it("explains an upstream authentication failure in Chinese", async () => {
  mocks.getKnowledgeBases.mockResolvedValueOnce({
    items: [],
    degraded: true,
    degraded_reason: "unauthorized",
  });
  const { ResearchChainKnowledgePanel } = await import("@/components/research/chains/research-chain-knowledge-panel");
  await act(async () => {
    root.render(<ResearchChainKnowledgePanel workspaceSlug="lab" chainId="chain-1" nodeId="node-1" />);
  });
  await act(async () => undefined);

  expect(container.textContent).toContain("认证失败");
  expect(container.textContent).toContain("人工记录可继续");
});

it("restores pending uploads for the selected node after a page reload", async () => {
  const { ResearchChainKnowledgePanel } = await import("@/components/research/chains/research-chain-knowledge-panel");
  mocks.getKnowledgeUploads.mockResolvedValueOnce({
    data: [
      {
        id: "upload-restored",
        status: "PENDING",
        knowledge_id: "knowledge-restored",
        knowledge_base_id: "kb-1",
        file_name: "restored.md",
        error_code: "",
      },
    ],
  });
  await act(async () => {
    root.render(<ResearchChainKnowledgePanel workspaceSlug="lab" chainId="chain-1" nodeId="node-1" />);
  });
  await act(async () => undefined);

  expect(mocks.getKnowledgeUploads).toHaveBeenCalledWith("lab", "chain-1", "node-1");
  expect(container.textContent).toContain("restored.md");
  expect(container.textContent).toContain("PENDING");
  expect(container.textContent).toContain("确认引用");
});

it("keeps the upload record available when reference confirmation fails", async () => {
  const { ResearchChainKnowledgePanel } = await import("@/components/research/chains/research-chain-knowledge-panel");
  mocks.confirmKnowledgeReference.mockRejectedValueOnce(new Error("conflict"));
  await act(async () => {
    root.render(<ResearchChainKnowledgePanel workspaceSlug="lab" chainId="chain-1" nodeId="node-1" />);
  });
  await act(async () => undefined);
  const input = container.querySelector('input[type="file"]');
  const file = new File(["# paper"], "paper.md", { type: "text/markdown" });
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file] });
    input?.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "通过 BFF 上传")?.click();
  });

  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "确认引用")?.click();
  });

  expect(mocks.confirmKnowledgeReference).toHaveBeenCalled();
  expect(container.textContent).toContain("paper.md");
  expect(container.textContent).toContain("操作未完成，当前记录已保留。");
  expect(container.querySelector("button")?.textContent).toContain("上传");
});

it("keeps validation failures actionable instead of presenting them as upstream degradation", async () => {
  const { ResearchChainKnowledgePanel } = await import("@/components/research/chains/research-chain-knowledge-panel");
  mocks.uploadKnowledgeFile.mockRejectedValueOnce({ error_code: "file_type_not_allowed" });
  await act(async () => {
    root.render(<ResearchChainKnowledgePanel workspaceSlug="lab" chainId="chain-1" nodeId="node-1" />);
  });
  await act(async () => undefined);

  const input = container.querySelector('input[type="file"]');
  const file = new File(["binary"], "paper.exe", { type: "application/octet-stream" });
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file] });
    input?.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "通过 BFF 上传")?.click();
  });

  expect(container.textContent).toContain("操作未完成，当前记录已保留。");
  expect(container.textContent).not.toContain("RAGPortal 当前降级");
});

it("blocks uploads while the chain knowledge request awaits administrator binding", async () => {
  mocks.getKnowledgeBases.mockResolvedValueOnce({
    items: [],
    state: "PENDING_ADMIN",
    request_id: "request-1",
    degraded: false,
  });
  const { ResearchChainKnowledgePanel } = await import("@/components/research/chains/research-chain-knowledge-panel");
  await act(async () => {
    root.render(<ResearchChainKnowledgePanel workspaceSlug="lab" chainId="chain-1" nodeId="node-1" />);
  });
  await act(async () => undefined);

  expect(container.textContent).toContain("管理员完成手工建库并回填后才能上传");
  expect(container.querySelector('input[type="file"]')?.hasAttribute("disabled")).toBe(true);
  expect(
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "通过 BFF 上传")
      ?.hasAttribute("disabled")
  ).toBe(true);
  expect(mocks.uploadKnowledgeFile).not.toHaveBeenCalled();
});
