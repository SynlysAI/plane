// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getKnowledgeBases: vi.fn(),
  getKnowledgeUploads: vi.fn(),
  getKnowledgeUpload: vi.fn(),
  onUploadStatusChanged: vi.fn(),
}));

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/services/research/chain.service", () => ({
  ResearchChainService: class {
    getKnowledgeBases = mocks.getKnowledgeBases;
    getKnowledgeUploads = mocks.getKnowledgeUploads;
    getKnowledgeUpload = mocks.getKnowledgeUpload;
  },
}));

const { useResearchChainKnowledge } = await import("@/components/research/chains/use-research-chain-knowledge");

const upload = {
  id: "upload-1",
  status: "PROCESSING",
  knowledge_id: "knowledge-1",
  knowledge_base_id: "kb-1",
  file_name: "paper.pdf",
  file_type: "pdf",
  file_size: 128,
  preview_url: "",
  download_url: "",
  error_code: "",
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
  mocks.getKnowledgeBases.mockResolvedValue({
    items: [{ external_id: "kb-1" }],
    degraded: false,
    uploadLimits: { pdf_max_mb: 500, markdown_max_mb: 500, office_max_mb: 500 },
  });
  mocks.getKnowledgeUploads.mockResolvedValue({ data: [upload] });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.useRealTimers();
});

it("polls a processing upload and reports convergence without a page reload", async () => {
  mocks.getKnowledgeUpload.mockResolvedValue({
    data: { ...upload, status: "SUCCESS" },
    degraded: false,
  });
  await act(async () => {
    root.render(
      <KnowledgeHarness workspaceSlug="lab" chainId="chain-1" nodeId="node-1" onChanged={mocks.onUploadStatusChanged} />
    );
  });
  await act(async () => await vi.advanceTimersByTimeAsync(0));
  expect(mocks.getKnowledgeUpload).not.toHaveBeenCalled();

  await act(async () => await vi.advanceTimersByTimeAsync(5_000));

  expect(mocks.getKnowledgeUpload).toHaveBeenCalledWith("lab", "chain-1", "upload-1");
  expect(mocks.onUploadStatusChanged).toHaveBeenCalledWith(
    expect.objectContaining({ id: "upload-1", status: "SUCCESS" }),
    "PROCESSING"
  );
});

function KnowledgeHarness(props: {
  workspaceSlug: string;
  chainId: string;
  nodeId: string;
  onChanged: (upload: unknown, previous: string) => void;
}) {
  useResearchChainKnowledge(props.workspaceSlug, props.chainId, props.nodeId, {
    onUploadStatusChanged: props.onChanged as never,
  });
  return null;
}
