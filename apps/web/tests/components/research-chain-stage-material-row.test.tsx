// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  uploadFiles: vi.fn(),
  createChainStageMaterial: vi.fn(),
  deleteChainStageMaterial: vi.fn(),
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
vi.mock("@plane/propel/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@/components/attachments/preview", () => ({
  AttachmentPreviewLink: ({ name }: { name: string }) => <span>{name}</span>,
}));
vi.mock("@/components/attachments/upload-zone", () => ({
  AttachmentUploadZone: (props: {
    disabled?: boolean;
    uploading?: boolean;
    title: string;
    inputAriaLabel?: string;
    onFiles: (files: File[]) => void;
  }) => (
    <label>
      {props.title}
      <input
        type="file"
        data-title={props.title}
        aria-label={props.inputAriaLabel ?? props.title}
        data-disabled={String(Boolean(props.disabled))}
        data-uploading={String(Boolean(props.uploading))}
        onChange={(event) => props.onFiles(Array.from(event.target.files ?? []))}
      />
    </label>
  ),
}));
vi.mock("@/services/research/chain.service", () => ({
  ResearchChainService: class {
    createChainStageMaterial = mocks.createChainStageMaterial;
    deleteChainStageMaterial = mocks.deleteChainStageMaterial;
  },
}));

const { ResearchChainStageMaterialRow } =
  await import("@/components/research/chains/research-chain-stage-material-row");

function material(seed: Record<string, unknown>) {
  return {
    id: "material-1",
    code: "TOPIC_TITLE",
    title: "题目",
    minimum_count: 1,
    submitted_count: 0,
    complete: false,
    submission_state: "INCOMPLETE",
    processing_count: 0,
    failed_count: 0,
    items: [],
    ...seed,
  };
}

function knowledge(seed: Record<string, unknown> = {}) {
  return {
    uploads: [],
    uploadLimits: { pdf_max_mb: 500, markdown_max_mb: 500, office_max_mb: 500 },
    maxUploadSizeBytes: 500 * 1024 * 1024,
    state: "ready",
    knowledgeBaseId: "kb-1",
    knowledgeState: "READY",
    orgUnitName: "",
    connectionStatus: "connected",
    degradedReason: "",
    actionError: "",
    uploading: false,
    processingMeta: {},
    canUpload: true,
    load: vi.fn(),
    uploadFiles: mocks.uploadFiles,
    refreshUpload: vi.fn(),
    confirmUpload: vi.fn(),
    ...seed,
  };
}

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

it("uploads and links each requirement independently", async () => {
  const first = material({});
  const second = material({ id: "material-2", code: "RESEARCH_QUESTION", title: "研究问题" });
  const onStageChanged = vi.fn();
  await act(async () => {
    root.render(
      <>
        {[first, second].map((item) => (
          <ResearchChainStageMaterialRow
            key={item.id}
            workspaceSlug="lab"
            chainId="chain-1"
            stageCode="TOPIC_SELECTION"
            material={item}
            editable
            busy={false}
            knowledge={knowledge()}
            onStageChanged={onStageChanged}
          />
        ))}
      </>
    );
  });

  const inputs = container.querySelectorAll<HTMLInputElement>('input[type="file"]');
  expect(inputs).toHaveLength(2);
  expect(inputs[0]?.getAttribute("aria-label")).toBe("题目 · 上传并关联");
  expect(inputs[1]?.getAttribute("aria-label")).toBe("研究问题 · 上传并关联");
  expect(inputs[1]?.dataset.disabled).toBe("false");
  const file = new File(["title"], "title.pdf", { type: "application/pdf" });
  mocks.uploadFiles.mockResolvedValueOnce([
    { id: "upload-1", status: "PROCESSING", file_name: "title.pdf", file_size: 4 },
  ]);
  mocks.createChainStageMaterial.mockResolvedValueOnce({});
  await act(async () => {
    Object.defineProperty(inputs[0], "files", { configurable: true, value: [file] });
    inputs[0].dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => await Promise.resolve());

  expect(mocks.createChainStageMaterial).toHaveBeenCalledWith("lab", "chain-1", "TOPIC_SELECTION", {
    requirement_code: "TOPIC_TITLE",
    upload_id: "upload-1",
  });
  expect(onStageChanged).toHaveBeenCalledTimes(1);
  expect(inputs[1]?.dataset.disabled).toBe("false");
});

it("renders one mutually exclusive state and explains historical text-only rows", async () => {
  await act(async () => {
    root.render(
      <ResearchChainStageMaterialRow
        workspaceSlug="lab"
        chainId="chain-1"
        stageCode="TOPIC_SELECTION"
        material={material({
          submission_state: "PROCESSING",
          processing_count: 1,
          items: [
            {
              id: "item-1",
              title: "历史题目",
              description: "",
              source_node: null,
              upload: "upload",
              upload_detail: {
                id: "upload",
                status: "PROCESSING",
                file_name: "历史题目.pdf",
                file_size: 128,
                preview_url: "",
                download_url: "",
                error_code: "",
              },
              external_reference: "",
              created_at: "2026-10-30T00:00:00Z",
            },
            {
              id: "item-2",
              title: "历史文字说明",
              description: "",
              source_node: null,
              upload: null,
              upload_detail: null,
              external_reference: "",
              created_at: "2026-10-30T00:00:00Z",
            },
          ],
        })}
        editable
        busy={false}
        knowledge={knowledge({
          processingMeta: { upload: { since: Date.now() - 3_000, lastPolledAt: 0 } },
        })}
        onStageChanged={vi.fn()}
      />
    );
  });

  const row = container.querySelector("li")!;
  expect(row.textContent).toContain("处理中，暂不可提交");
  expect(row.textContent).toContain("已等待 3 秒");
  expect(row.textContent).toContain("历史文字记录，不计入完成度");
  expect(row.textContent).not.toContain("解析失败");
});
