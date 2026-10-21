// @vitest-environment jsdom
import { expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ patch: vi.fn(), post: vi.fn() }));

vi.mock("@plane/constants", () => ({
  API_BASE_URL: "https://plane.test",
  researchEndpoints: {
    agentApproval: (workspaceSlug: string, runId: string) =>
      `/api/research/workspaces/${workspaceSlug}/agent/runs/${runId}/approvals/`,
    chainNodeTasks: (workspaceSlug: string, chainId: string, nodeId: string) =>
      `/api/research/workspaces/${workspaceSlug}/chains/${chainId}/nodes/${nodeId}/tasks/`,
    chainNodeTaskAction: (workspaceSlug: string, chainId: string, nodeId: string, taskId: string, action: string) =>
      `/api/research/workspaces/${workspaceSlug}/chains/${chainId}/nodes/${nodeId}/tasks/${taskId}/${action}/`,
  },
}));
vi.mock("@/services/api.service", () => ({
  APIService: class {
    patch = calls.patch;
    post = calls.post;
  },
}));

const { IssueService } = await import("@/services/issue/issue.service");
const { WorkspaceDraftService } = await import("@/services/issue/workspace_draft.service");
const { InboxIssueService } = await import("@/services/inbox/inbox-issue.service");
const { ResearchChainTaskService } = await import("@/services/research/chain-task.service");
const { ResearchAgentService } = await import("@/services/research/agent.service");

async function expectTodoEvent(action: () => Promise<unknown>, request: ReturnType<typeof vi.fn>) {
  const event = vi.fn();
  window.addEventListener("workspace-todos-updated", event, { once: true });
  request.mockResolvedValueOnce({ data: {} });
  await action();
  expect(event).toHaveBeenCalledTimes(1);
}

it("dispatches one refresh event after a work item update", async () => {
  await expectTodoEvent(
    () => new IssueService().patchIssue("lab", "project-1", "issue-1", { assignee_ids: ["member-1"] }),
    calls.patch
  );
});

it("dispatches one refresh event after a draft update", async () => {
  await expectTodoEvent(
    () => new WorkspaceDraftService().updateIssue("lab", "issue-1", { assignee_ids: ["member-1"] }),
    calls.patch
  );
});

it("dispatches one refresh event after an Inbox issue update", async () => {
  await expectTodoEvent(
    () => new InboxIssueService().updateIssue("lab", "project-1", "issue-1", { assignee_ids: ["member-1"] }),
    calls.patch
  );
});

it("dispatches one refresh event after a research task action", async () => {
  const event = vi.fn();
  window.addEventListener("workspace-todos-updated", event, { once: true });
  calls.post.mockResolvedValueOnce({
    data: { success: true, data: { id: "task-1" }, error: null, request_id: null, schema_version: "test" },
  });
  await new ResearchChainTaskService().runNodeTaskAction("lab", "chain-1", "node-1", "task-1", "submit", {});
  expect(event).toHaveBeenCalledTimes(1);
});

it("dispatches one refresh event after an Agent approval decision", async () => {
  await expectTodoEvent(
    () =>
      new ResearchAgentService().decideApproval("lab", "run-1", {
        request_id: "request-1",
        decision: "APPROVED",
        tool_call_id: "tool-1",
      }),
    calls.post
  );
});
