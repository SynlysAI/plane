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

import { NativeMCPManager } from "@/components/mcp/native-mcp-manager";
import { MCPManagement } from "@/components/mcp/mcp-management";
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
function select(name: string, value: string) {
  const element = container.querySelector<HTMLSelectElement>(`select[aria-label="${name}"]`)!;
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

it("renders only native MCP configuration and ignores historical research context", async () => {
  mocks.query = "mode=research&chain=chain-1&node=node-1&operation=op-1";
  await render(<MCPManagement workspaceSlug="public" />);
  expect(container.textContent).toContain("MCP 配置");
  expect(container.textContent).toContain("行政项目接入");
  expect(container.textContent).not.toContain("科研链节点接入");
  expect(container.textContent).not.toContain("Agent 操作审核");
  expect(container.textContent).not.toContain("生成当前节点连接配置");
  expect(mocks.chainPage).not.toHaveBeenCalled();
  expect(mocks.nodes).not.toHaveBeenCalled();
  expect(mocks.tasks).not.toHaveBeenCalled();
  expect(mocks.nativeRead).toHaveBeenCalledWith("options");
});

it("workspace navigation removes node, task, proposal and credentials", async () => {
  mocks.query = "mode=research&workspace=second&chain=chain-1&node=node-1&operation=op-1";
  await render(<MCPManagement workspaceSlug="public" />);
  await act(async () => select("MCP 工作区", "second"));
  expect(Object.fromEntries(mocks.setParams.mock.calls[0][0])).toEqual({ workspace: "second" });
});

it("renders only native configuration inside settings", async () => {
  mocks.query = "mode=research&workspace=second&chain=chain-1&node=node-1&operation=op-1";
  await render(<MCPProfileSettings />);
  expect(container.querySelector('[aria-label="行政项目接入"]')).not.toBeNull();
  expect(container.textContent).not.toContain("科研链节点接入");
  expect(container.textContent).not.toContain("Agent 操作审核");
  expect(mocks.chainPage).not.toHaveBeenCalled();
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

it("redirects legacy research links into native settings with only the workspace", async () => {
  mocks.query = "node=node-1&chain=chain-1&task=task-1&operation=op-1&token=secret&workspace=other";
  await render(<MCPManagementRedirect workspaceSlug="public" />);
  const redirect = container.querySelector('[data-testid="redirect"]');
  const url = new URL(redirect!.getAttribute("data-to")!, "https://plane.test");
  expect(url.pathname).toBe("/settings/profile/mcp/");
  expect(Object.fromEntries(url.searchParams)).toEqual({ workspace: "public" });
  expect(redirect?.getAttribute("data-replace")).toBe("true");
});

it("redirects the legacy global entry to settings with workspace selection", async () => {
  await render(<MCPManagementRedirect />);
  expect(container.querySelector('[data-testid="redirect"]')?.getAttribute("data-to")).toBe("/settings/profile/mcp/");
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
