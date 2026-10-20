import { afterEach, beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ post: vi.fn(), delete: vi.fn(), fetch: vi.fn() }));

vi.mock("@plane/constants", () => ({
  API_BASE_URL: "https://plane.test",
  researchEndpoints: {
    chainNodeTask: (workspaceSlug: string, chainId: string, nodeId: string, taskId: string) =>
      `/api/research/workspaces/${workspaceSlug}/chains/${chainId}/nodes/${nodeId}/tasks/${taskId}/`,
  },
}));
vi.mock("@/services/api.service", () => ({
  APIService: class {
    post = calls.post;
    delete = calls.delete;
  },
}));

const { ResearchChainTaskService } = await import("@/services/research/chain-task.service");

const BASE_URL = "/api/research/workspaces/lab/chains/chain-1/nodes/node-1/tasks/task-1/";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", calls.fetch);
  calls.fetch.mockResolvedValue({ ok: true });
  calls.delete.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("normalizes the confirm asset_id into a comment attachment id", async () => {
  calls.post
    .mockResolvedValueOnce({
      data: {
        asset_id: "asset-1",
        upload_data: { url: "https://storage.test", fields: { key: "value" } },
      },
    })
    .mockResolvedValueOnce({
      data: {
        asset_id: "asset-1",
        name: "导师信息表.xlsx",
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 10768,
      },
    });

  const attachment = await new ResearchChainTaskService().uploadTaskCommentAttachment(
    "lab",
    "chain-1",
    "node-1",
    "task-1",
    new File(["workbook"], "导师信息表.xlsx")
  );

  expect(attachment).toEqual({
    id: "asset-1",
    name: "导师信息表.xlsx",
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 10768,
    download_url: `${BASE_URL}comment-attachments/asset-1/download/`,
  });
  expect(calls.post).toHaveBeenCalledTimes(2);
  expect(calls.delete).not.toHaveBeenCalled();
});

it("rejects and discards a slot when confirm has no asset_id", async () => {
  calls.post
    .mockResolvedValueOnce({
      data: {
        asset_id: "asset-1",
        upload_data: { url: "https://storage.test", fields: {} },
      },
    })
    .mockResolvedValueOnce({ data: { name: "导师信息表.xlsx" } });

  await expect(
    new ResearchChainTaskService().uploadTaskCommentAttachment(
      "lab",
      "chain-1",
      "node-1",
      "task-1",
      new File(["workbook"], "导师信息表.xlsx")
    )
  ).rejects.toEqual({ error_code: "research_task_comment_attachment_confirm_invalid" });
  expect(calls.delete).toHaveBeenCalledWith(`${BASE_URL}comment-attachments/asset-1/`);
});
