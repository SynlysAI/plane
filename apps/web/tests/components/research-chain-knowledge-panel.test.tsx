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
      status: "PROCESSING",
      knowledge_id: "knowledge-1",
      knowledge_base_id: "kb-1",
      file_name: "paper.md",
      file_type: "md",
      file_size: 7,
      preview_url: "/preview/upload-1/",
      download_url: "/download/upload-1/",
      error_code: "",
    },
  });
});

afterEach(() => {
  root.unmount();
  container.remove();
  vi.clearAllMocks();
});

async function renderPanel() {
  const { ResearchChainKnowledgePanel } = await import("@/components/research/chains/research-chain-knowledge-panel");
  const { useResearchChainKnowledge } = await import("@/components/research/chains/use-research-chain-knowledge");
  function KnowledgeHarness() {
    const knowledge = useResearchChainKnowledge("lab", "chain-1", "node-1");
    return <ResearchChainKnowledgePanel knowledge={knowledge} />;
  }
  await act(async () => {
    root.render(<KnowledgeHarness />);
  });
}

async function selectFile(file: File) {
  const input = container.querySelector('input[type="file"]');
  await act(async () => {
    Object.defineProperty(input as HTMLInputElement, "files", { configurable: true, value: [file] });
    input?.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => await Promise.resolve());
}

it("uploads a selected file to the bound group library without a library selector", async () => {
  await renderPanel();
  await act(async () => undefined);

  expect(container.querySelector("h3")?.textContent).toContain("课题资料");
  expect(container.querySelector("select")).toBeNull();
  expect(container.textContent).toContain("选择资料");
  expect(container.textContent).toContain("单文件不超过 50MB");
  await selectFile(new File(["# paper"], "paper.md", { type: "text/markdown" }));

  expect(mocks.uploadKnowledgeFile).toHaveBeenCalledWith(
    "lab",
    "chain-1",
    "node-1",
    "kb-1",
    expect.objectContaining({ name: "paper.md" })
  );
  expect(container.textContent).toContain("paper.md");
  expect(container.textContent).toContain("解析中");
});

it("explains an upstream authentication failure in Chinese", async () => {
  mocks.getKnowledgeBases.mockResolvedValueOnce({
    items: [],
    degraded: true,
    degraded_reason: "unauthorized",
  });
  await renderPanel();
  await act(async () => undefined);

  expect(container.textContent).toContain("认证失败");
  expect(container.textContent).toContain("人工记录可继续");
});

it("restores processing uploads for the selected node after a page reload", async () => {
  mocks.getKnowledgeUploads.mockResolvedValueOnce({
    data: [
      {
        id: "upload-restored",
        status: "PROCESSING",
        knowledge_id: "knowledge-restored",
        knowledge_base_id: "kb-1",
        file_name: "restored.md",
        file_type: "md",
        file_size: 11,
        preview_url: "/preview/upload-restored/",
        download_url: "/download/upload-restored/",
        error_code: "",
      },
    ],
  });
  await renderPanel();
  await act(async () => undefined);

  expect(mocks.getKnowledgeUploads).toHaveBeenCalledWith("lab", "chain-1", "node-1");
  expect(container.textContent).toContain("restored.md");
  expect(container.textContent).toContain("解析中");
  expect(container.textContent).toContain("确认引用");
  expect(container.querySelector('a[aria-label="下载资料"]')?.getAttribute("href")).toBe("/download/upload-restored/");
});

it("keeps the upload record available when reference confirmation fails", async () => {
  mocks.confirmKnowledgeReference.mockRejectedValueOnce(new Error("conflict"));
  await renderPanel();
  await act(async () => undefined);
  await selectFile(new File(["# paper"], "paper.md", { type: "text/markdown" }));

  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "确认引用")?.click();
  });

  expect(mocks.confirmKnowledgeReference).toHaveBeenCalled();
  expect(container.textContent).toContain("paper.md");
  expect(container.textContent).toContain("操作未完成，当前记录已保留。");
  expect(container.textContent).toContain("选择资料");
});

it("keeps validation failures actionable instead of presenting them as upstream degradation", async () => {
  mocks.uploadKnowledgeFile.mockRejectedValueOnce({ error_code: "file_type_not_allowed" });
  await renderPanel();
  await act(async () => undefined);
  await selectFile(new File(["binary"], "paper.md", { type: "text/markdown" }));

  expect(container.textContent).toContain("不支持该文件类型。");
  expect(container.textContent).not.toContain("RAGPortal 当前降级");
});

it("explains a gateway 413 response as the research-chain size limit", async () => {
  mocks.uploadKnowledgeFile.mockRejectedValueOnce({
    error_code: "file_size_exceeded",
    message: "",
    status: 413,
  });
  await renderPanel();
  await act(async () => undefined);
  await selectFile(new File(["paper"], "paper.pdf", { type: "application/pdf" }));

  expect(container.textContent).toContain("文件被网关拒绝，研究链资料单文件不能超过 50MB。");
  expect(mocks.uploadKnowledgeFile).toHaveBeenCalled();
});

it("rejects files over 50MB before sending a request", async () => {
  await renderPanel();
  await act(async () => undefined);

  const file = new File(["paper"], "large.pdf", { type: "application/pdf" });
  Object.defineProperty(file, "size", { value: 50 * 1024 * 1024 + 1 });
  await selectFile(file);

  expect(container.textContent).toContain("文件超过大小限制。");
  expect(mocks.uploadKnowledgeFile).not.toHaveBeenCalled();
});

it("blocks uploads while the chain knowledge request awaits administrator binding", async () => {
  mocks.getKnowledgeBases.mockResolvedValueOnce({
    items: [],
    state: "PENDING_ADMIN",
    request_id: "request-1",
    degraded: false,
  });
  await renderPanel();
  await act(async () => undefined);

  expect(container.textContent).toContain("等待管理员从候选库确认");
  const input = container.querySelector('input[type="file"]');
  expect(input?.hasAttribute("disabled")).toBe(true);
  expect(container.textContent).not.toContain("拖拽文件或文件夹到这里");
  expect(mocks.uploadKnowledgeFile).not.toHaveBeenCalled();
});
