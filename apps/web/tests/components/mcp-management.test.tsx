// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chainPage: vi.fn(),
  chain: vi.fn(),
  nodes: vi.fn(),
  tasks: vi.fn(),
  nativeRead: vi.fn(),
  nativeWrite: vi.fn(),
  query: "",
  profileTabId: "mcp" as string | undefined,
  setParams: vi.fn(),
  navigate: vi.fn(),
  fetchWorkspaces: vi.fn(),
  workspaces: {
    one: { id: "one", slug: "public", name: "Public" },
    two: { id: "two", slug: "second", name: "Second" },
  },
}));
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
vi.mock("@/services/research/chain.service", () => ({
  ResearchChainService: class {
    getChainPage = mocks.chainPage;
    getChain = mocks.chain;
    getChainNodes = mocks.nodes;
  },
}));
vi.mock("@/services/research/chain-task.service", () => ({
  ResearchChainTaskService: class {
    getNodeTasks = mocks.tasks;
  },
}));
vi.mock("@/services/mcp.service", () => ({
  NativeMCPService: class {
    read = mocks.nativeRead;
    write = mocks.nativeWrite;
  },
}));
vi.mock("@/components/research/chains/research-agent-operations", () => ({
  ResearchAgentOperations: (props: { workspaceSlug: string; nodeId: string; operationId?: string }) => (
    <div
      data-testid="review"
      data-workspace={props.workspaceSlug}
      data-node={props.nodeId}
      data-operation={props.operationId}
    >
      shared-human-review
    </div>
  ),
}));
vi.mock("@/components/core/page-title", () => ({ PageHead: () => null }));
vi.mock("@/hooks/store/use-workspace", () => ({ useWorkspace: () => workspaceStore }));
vi.mock("react-router", () => ({
  useParams: () => ({ profileTabId: mocks.profileTabId }),
  Navigate: ({ to, replace }: { to: string; replace?: boolean }) => (
    <div data-testid="redirect" data-to={to} data-replace={replace} />
  ),
  useNavigate: () => mocks.navigate,
  useSearchParams: () => [new URLSearchParams(mocks.query), mocks.setParams],
}));

import { ResearchMCPManager } from "@/components/mcp/research-mcp-manager";
import { ResearchNodeMCPEntry } from "@/components/mcp/research-node-mcp-entry";
import { NativeMCPManager } from "@/components/mcp/native-mcp-manager";
import { MCPManagement } from "@/components/mcp/mcp-management";
import { mcpManagementPath } from "@/components/mcp/mcp-context";
import { MCPManagementRedirect } from "@/components/mcp/mcp-management-redirect";
import { MCPProfileSettings } from "@/components/settings/profile/content/pages/mcp";

const workspaceStore = {
  workspaces: mocks.workspaces,
  fetchWorkspaces: mocks.fetchWorkspaces,
  currentWorkspace: mocks.workspaces.one,
};
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const options = {
  workspaces: ["public"],
  allow_publish: false,
  max_token_days: 7,
  portal_url: "https://native.test/connect",
  plane_ui_url: "https://remote-plane.test",
  csrf_token: "plane-csrf",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query = "";
  mocks.profileTabId = "mcp";
  mocks.chainPage.mockResolvedValue({
    results: [{ id: "chain-1", project_name: "Research" }],
    next_page_results: false,
  });
  mocks.chain.mockResolvedValue({ id: "chain-2", project_name: "Older chain" });
  mocks.nodes.mockResolvedValue([
    { id: "node-1", chain: "chain-1", title: "First", status: "ACTIVE" },
    { id: "node-2", chain: "chain-1", title: "Second", status: "DRAFT" },
  ]);
  mocks.tasks.mockResolvedValue([{ id: "task-1", title: "Research task" }]);
  mocks.nativeRead.mockImplementation((action: string) =>
    action === "options"
      ? Promise.resolve(options)
      : action === "session"
        ? Promise.reject({ status: 401 })
        : Promise.resolve({ tokens: [] })
  );
  mocks.nativeWrite.mockResolvedValue({ name: "Verified user", csrf: "native-csrf" });
  mocks.fetchWorkspaces.mockResolvedValue([]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(element: React.ReactNode) {
  await act(async () => root.render(element));
}
function button(text: string) {
  return Array.from(container.querySelectorAll("button")).find((item) => item.textContent === text)!;
}
function select(name: string, value: string) {
  const element = container.querySelector<HTMLSelectElement>(`select[aria-label="${name}"]`)!;
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

it("passes only location context to the unified page", () => {
  const path = mcpManagementPath("public", { chain: "chain-1", node: "node-1", task: "task-1", operation: "op-1" });
  const url = new URL(path, "https://plane.test");
  expect(url.pathname).toBe("/settings/profile/mcp/");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    mode: "research",
    workspace: "public",
    chain: "chain-1",
    node: "node-1",
    task: "task-1",
    operation: "op-1",
  });
});

it("always renders a node entry even without MCP enabled and retains historical review paths", async () => {
  await render(<ResearchNodeMCPEntry workspaceSlug="public" chainId="chain-1" nodeId="node-1" />);
  expect(container.textContent).toContain("MCP / Agent 操作");
  expect(container.querySelector('[data-testid="review"]')).toBeNull();
  await render(
    <ResearchNodeMCPEntry workspaceSlug="public" chainId="chain-1" nodeId="node-1" operationId="old-operation" />
  );
  expect(container.querySelector('[data-testid="review"]')?.getAttribute("data-operation")).toBe("old-operation");
  expect(container.querySelector("a")?.href).toContain("operation=old-operation");
});

it("checks chain, node and optional task before mounting the shared approval component", async () => {
  await render(
    <ResearchMCPManager
      workspaceSlug="public"
      context={{ chain: "chain-1", node: "node-1", task: "task-1", operation: "op-1" }}
      onContextChange={vi.fn()}
    />
  );
  expect(mocks.tasks).toHaveBeenCalledWith("public", "chain-1", "node-1");
  expect(container.textContent).toContain("来源科研任务：Research task");
  expect(container.querySelector('[data-testid="review"]')?.getAttribute("data-node")).toBe("node-1");
});

it("does not mount authorization for a node outside the selected chain", async () => {
  await render(
    <ResearchMCPManager
      workspaceSlug="public"
      context={{ chain: "chain-1", node: "foreign" }}
      onContextChange={vi.fn()}
    />
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("不属于当前科研链");
  expect(container.querySelector('[data-testid="review"]')).toBeNull();
});

it("rejects an unrelated task context", async () => {
  await render(
    <ResearchMCPManager
      workspaceSlug="public"
      context={{ chain: "chain-1", node: "node-1", task: "foreign-task" }}
      onContextChange={vi.fn()}
    />
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("任务不属于当前节点");
  expect(container.querySelector('[data-testid="review"]')).toBeNull();
});

it("changing a node clears task and proposal context", async () => {
  const onChange = vi.fn();
  await render(
    <ResearchMCPManager
      workspaceSlug="public"
      context={{ chain: "chain-1", node: "node-1", task: "task-1", operation: "old-op" }}
      onContextChange={onChange}
    />
  );
  await act(async () => select("科研节点", "node-2"));
  expect(onChange).toHaveBeenCalledWith({ chain: "chain-1", node: "node-2" });
});

it("ignores an earlier node lookup that resolves after switching", async () => {
  let resolveOld!: (items: unknown) => void;
  mocks.nodes.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      })
  );
  await render(
    <ResearchMCPManager
      workspaceSlug="public"
      context={{ chain: "chain-1", node: "node-1" }}
      onContextChange={vi.fn()}
    />
  );
  await render(
    <ResearchMCPManager
      workspaceSlug="public"
      context={{ chain: "chain-1", node: "node-2" }}
      onContextChange={vi.fn()}
    />
  );
  await act(async () => resolveOld([{ id: "node-1", chain: "chain-1" }]));
  expect(container.querySelector('[data-testid="review"]')?.getAttribute("data-node")).toBe("node-2");
});

it("workspace navigation does not carry node, task, proposal or credentials", async () => {
  mocks.query = "mode=research&chain=chain-1&node=node-1&operation=op-1";
  await render(<MCPManagement workspaceSlug="public" />);
  await act(async () => select("MCP 工作区", "second"));
  expect(Object.fromEntries(mocks.setParams.mock.calls[0][0])).toEqual({ mode: "research", workspace: "second" });
});

it("switching connection type removes all research context", async () => {
  mocks.query = "mode=research&chain=chain-1&node=node-1";
  await render(<MCPManagement workspaceSlug="public" />);
  await act(async () => button("行政项目接入").click());
  expect(mocks.setParams.mock.calls[0][0].toString()).toBe("mode=native&workspace=public");
});

it("renders shared management inside settings using explicit workspace and proposal context", async () => {
  mocks.query = "mode=research&workspace=second&chain=chain-1&node=node-1&operation=op-1";
  await render(<MCPProfileSettings />);
  const review = container.querySelector('[data-testid="review"]');
  expect(review?.getAttribute("data-workspace")).toBe("second");
  expect(review?.getAttribute("data-operation")).toBe("op-1");
});

it("keeps modal selections isolated from the underlying workbench URL", async () => {
  mocks.query = "mode=research&workspace=second&chain=chain-1&node=node-1&operation=old-op";
  await render(<MCPProfileSettings inModal />);
  expect(container.querySelector('[data-testid="review"]')).toBeNull();
  expect(container.querySelector<HTMLSelectElement>('select[aria-label="MCP 工作区"]')?.value).toBe("public");
  await act(async () => select("MCP 工作区", "second"));
  expect(container.querySelector<HTMLSelectElement>('select[aria-label="MCP 工作区"]')?.value).toBe("second");
  expect(mocks.setParams).not.toHaveBeenCalled();
});

it("redirects legacy workspace links into settings preserving location and dropping secrets", async () => {
  mocks.query = "node=node-1&chain=chain-1&task=task-1&operation=op-1&token=secret&workspace=other";
  await render(<MCPManagementRedirect workspaceSlug="public" />);
  const redirect = container.querySelector('[data-testid="redirect"]');
  const url = new URL(redirect!.getAttribute("data-to")!, "https://plane.test");
  expect(url.pathname).toBe("/settings/profile/mcp/");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    mode: "research",
    workspace: "public",
    node: "node-1",
    chain: "chain-1",
    task: "task-1",
    operation: "op-1",
  });
  expect(redirect?.getAttribute("data-replace")).toBe("true");
});

it("redirects the legacy global entry to settings with workspace selection", async () => {
  await render(<MCPManagementRedirect />);
  expect(container.querySelector('[data-testid="redirect"]')?.getAttribute("data-to")).toBe(
    "/settings/profile/mcp/?mode=native"
  );
});

it("reads native limits from the service and authenticates with separate CSRF values", async () => {
  await render(<NativeMCPManager workspaceSlug="public" />);
  expect(container.textContent).toContain("连接最长 7 天");
  const token = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  token.value = "private-native-pat";
  await act(async () =>
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  expect(mocks.nativeWrite).toHaveBeenCalledWith("login", { plane_token: "private-native-pat" }, "plane-csrf", "");
  expect(container.textContent).toContain("Verified user");
  expect(container.textContent).not.toContain("private-native-pat");
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  mocks.nativeWrite.mockResolvedValue({
    id: "native-1",
    workspace: "public",
    codex_toml: "Bearer one-time-secret",
    sciencediscovery_json: "{}",
  });
  await act(async () =>
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  expect(mocks.nativeWrite).toHaveBeenLastCalledWith(
    "tokens",
    { workspace: "public", label: "我的 Agent", days: 7, publish: false },
    "plane-csrf",
    "native-csrf"
  );
  expect(container.querySelector("textarea")?.value).toContain("one-time-secret");
  await render(<NativeMCPManager workspaceSlug="second" />);
  expect(container.querySelector("textarea")).toBeNull();
  expect(container.textContent).toContain("尚未开放当前工作区");
});

it("does not show delayed native connection secrets after workspace changes", async () => {
  mocks.nativeRead.mockImplementation((action: string) =>
    Promise.resolve(
      action === "options" ? options : action === "session" ? { name: "User", csrf: "native-csrf" } : { tokens: [] }
    )
  );
  let resolveOld!: (result: unknown) => void;
  mocks.nativeWrite.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      })
  );
  await render(<NativeMCPManager workspaceSlug="public" />);
  await act(async () =>
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  await render(<NativeMCPManager workspaceSlug="second" />);
  await act(async () => resolveOld({ codex_toml: "must-not-cross-workspaces", sciencediscovery_json: "{}" }));
  expect(container.querySelector("textarea")).toBeNull();
});

it("requires an explicit service target when the native Plane has different workspaces", async () => {
  await render(<NativeMCPManager workspaceSlug="local-only" />);
  expect(container.querySelector("form")).toBeNull();
  expect(container.querySelector<HTMLSelectElement>('[aria-label="行政服务目标工作区"]')?.value).toBe("");
  await act(async () => select("行政服务目标工作区", "public"));
  expect(container.querySelector('input[type="password"]')).not.toBeNull();
  expect(container.querySelector('a[href*="api-tokens"]')?.getAttribute("href")).toBe(
    "https://remote-plane.test/settings/profile/api-tokens/"
  );
  expect(mocks.nativeWrite).not.toHaveBeenCalled();
});

it("issues only for the explicitly selected native target and hides the previous target's secret", async () => {
  mocks.nativeRead.mockImplementation((action: string) =>
    Promise.resolve(
      action === "options"
        ? { ...options, workspaces: ["public", "second"] }
        : action === "session"
          ? { name: "User", csrf: "native-csrf" }
          : { tokens: [] }
    )
  );
  mocks.nativeWrite.mockResolvedValue({ codex_toml: "target-specific-secret", sciencediscovery_json: "{}" });
  await render(<NativeMCPManager workspaceSlug="public" />);
  await act(async () =>
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  expect(container.querySelector("textarea")?.value).toContain("target-specific-secret");
  await act(async () => select("行政服务目标工作区", "second"));
  expect(container.querySelector("textarea")).toBeNull();
  await act(async () =>
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  expect(mocks.nativeWrite).toHaveBeenLastCalledWith(
    "tokens",
    { workspace: "second", label: "我的 Agent", days: 7, publish: false },
    "plane-csrf",
    "native-csrf"
  );
});

it("keeps request generations distinct after repeated native target and Plane workspace changes", async () => {
  mocks.nativeRead.mockImplementation((action: string) =>
    Promise.resolve(
      action === "options"
        ? { ...options, workspaces: ["public", "second"] }
        : action === "session"
          ? { name: "User", csrf: "native-csrf" }
          : { tokens: [] }
    )
  );
  let resolveOld!: (result: unknown) => void;
  mocks.nativeWrite.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      })
  );
  await render(<NativeMCPManager workspaceSlug="public" />);
  await act(async () => select("行政服务目标工作区", "second"));
  await act(async () => select("行政服务目标工作区", "public"));
  await act(async () =>
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  await render(<NativeMCPManager workspaceSlug="second" />);
  await act(async () => resolveOld({ codex_toml: "must-not-cross-targets", sciencediscovery_json: "{}" }));
  expect(container.querySelector("textarea")).toBeNull();
});
