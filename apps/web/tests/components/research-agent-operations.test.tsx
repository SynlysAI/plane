// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getState: vi.fn(), act: vi.fn() }));
vi.mock("@plane/constants", () => ({ API_BASE_URL: "http://plane.test" }));
vi.mock("@plane/propel/button", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("@/services/research/agent-operation.service", () => ({
  ResearchAgentOperationService: class {
    getState = mocks.getState;
    act = mocks.act;
  },
}));

import { ResearchAgentOperations } from "@/components/research/chains/research-agent-operations";

const proposal = {
  operation_id: "operation-1",
  node_id: "node-1",
  chain_id: "chain-1",
  action: "create_task",
  payload: { title: "核对温度 <script>untrusted()</script>" },
  target: { node_title: "首轮分析" },
  source_refs: [],
  proposal_hash: "exact-hash",
  agent_label: "Codex",
  status: "PROPOSED",
  expires_at: "2099-01-01T00:00:00Z",
  result: {},
};
const state = (overrides = {}) => ({
  enabled: true,
  can_configure: false,
  csrf_token: "session-csrf",
  allowed_actions: ["create_task"],
  operations: [proposal],
  next_cursor: null,
  grants: [],
  report_options: [],
  ...overrides,
});

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.getState.mockResolvedValue(state());
  mocks.act.mockResolvedValue({});
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(nodeId = "node-1", operationId?: string) {
  await act(async () =>
    root.render(<ResearchAgentOperations workspaceSlug="workspace" nodeId={nodeId} operationId={operationId} />)
  );
}
function button(text: string) {
  return Array.from(container.querySelectorAll("button")).find((element) => element.textContent === text)!;
}

it("shows exact proposed content as text and approves the immutable hash with CSRF", async () => {
  await render();
  expect(container.textContent).toContain(proposal.payload.title);
  expect(container.textContent).toContain("目标节点：首轮分析");
  expect(container.querySelector("script")).toBeNull();
  expect(mocks.act).not.toHaveBeenCalled();
  await act(async () => button("确认这项变更").click());
  expect(mocks.act).toHaveBeenCalledWith("workspace", "node-1", "session-csrf", {
    kind: "decision",
    operation_id: "operation-1",
    proposal_hash: "exact-hash",
    decision: "APPROVED",
  });
});

it("rejects explicitly and never executes a business operation from the approval UI", async () => {
  await render();
  await act(async () => button("拒绝").click());
  expect(mocks.act.mock.calls[0][3]).toEqual({
    kind: "decision",
    operation_id: "operation-1",
    proposal_hash: "exact-hash",
    decision: "REJECTED",
  });
  expect(container.textContent).not.toContain("立即执行");
});

it("requires explicit selected actions and hides the one-time connection secret", async () => {
  mocks.act.mockResolvedValue({
    context_id: "grant-1",
    expires_at: "2099-01-01",
    mcp_path: "/api/research/operations/mcp/",
    headers: { "X-Research-Context-Token": "private-test-token" },
  });
  await render();
  expect(button("生成当前节点连接配置").disabled).toBe(true);
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("生成当前节点连接配置").click());
  expect(mocks.act.mock.calls[0][3]).toEqual({
    kind: "issue_grant",
    actions: ["create_task"],
    agent_label: "Codex",
    reports: [],
  });
  expect(container.querySelector("textarea")?.value).toContain("private-test-token");
  await act(async () => button("隐藏连接密钥").click());
  expect(container.querySelector("textarea")).toBeNull();
});

it("does not enable a workspace or approve while write policy is disabled", async () => {
  mocks.getState.mockResolvedValue(state({ enabled: false, can_configure: true }));
  await render();
  expect(mocks.act).not.toHaveBeenCalled();
  expect(button("确认这项变更").disabled).toBe(true);
  await act(async () => button("启用工作区 Agent 操作").click());
  expect(mocks.act.mock.calls[0][3]).toEqual({ kind: "workspace_policy", enabled: true });
});

it("keeps delayed responses from a previous node out of the current node", async () => {
  let resolveOld!: (value: unknown) => void;
  mocks.getState
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    )
    .mockResolvedValueOnce(state({ operations: [] }));
  await render("old-node");
  await render("new-node");
  await act(async () => resolveOld(state()));
  expect(container.textContent).not.toContain(proposal.payload.title);
});

it("loads a deep-linked proposal and reports approval failure without showing success", async () => {
  await render("node-1", "operation-1");
  expect(mocks.getState).toHaveBeenCalledWith("workspace", "node-1", { operation_id: "operation-1" });
  mocks.act.mockRejectedValue({ message: "提案已到期" });
  await act(async () => button("确认这项变更").click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("提案已到期");
});
