// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observable, runInAction } from "mobx";
const mocks = vi.hoisted(() => ({
  options: vi.fn(),
  connections: vi.fn(),
  issue: vi.fn(),
  revoke: vi.fn(),
  copy: vi.fn(),
  download: vi.fn(),
  user: "current-user",
  params: "",
}));
vi.mock("@plane/propel/button", () => ({
  Button: ({ children, variant: _variant, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock("@plane/ui", () => ({
  AlertModalCore: ({ isOpen, content, handleSubmit, handleClose, isSubmitting }: any) =>
    isOpen ? (
      <div role="dialog">
        {content}
        <button disabled={isSubmitting} onClick={handleSubmit}>
          确认撤销
        </button>
        <button disabled={isSubmitting} onClick={handleClose}>
          取消撤销
        </button>
      </div>
    ) : null,
}));
vi.mock("@plane/utils", () => ({ copyTextToClipboard: mocks.copy }));
vi.mock("@/components/core/local-date", () => ({
  LocalDate: ({ value, emptyLabel }: any) => <span>{value || emptyLabel}</span>,
}));
vi.mock("@/components/core/page-title", () => ({ PageHead: () => null }));
vi.mock("@/components/mcp/connection-download", () => ({ downloadMCPConfiguration: mocks.download }));
vi.mock("@/components/mcp/legacy-mcp-management", () => ({ LegacyMCPManagement: () => <div>旧连接管理已加载</div> }));
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: userState }) }));
vi.mock("react-router", () => ({ useSearchParams: () => [new URLSearchParams(mocks.params)] }));
vi.mock("@/services/unified-mcp.service", () => ({
  UnifiedMCPService: class {
    options = mocks.options;
    connections = mocks.connections;
    issue = mocks.issue;
    revoke = mocks.revoke;
  },
}));
import { UnifiedMCPManager } from "@/components/mcp/unified-mcp-manager";
import { MCPManagement } from "@/components/mcp/mcp-management";
import { unifiedConfiguration, unifiedMetadata } from "@/components/mcp/unified-config";
import type { UnifiedIssued, UnifiedWorkspace } from "@/services/unified-mcp.service";
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const userState = observable({ id: "current-user" });
const one = {
  id: "one",
  slug: "first",
  name: "工作区一",
  domains: { administrative: ["read", "read_write"], research: ["read", "read_write"] },
} as UnifiedWorkspace;
const two = {
  id: "two",
  slug: "second",
  name: "工作区二",
  domains: { administrative: ["read", "read_write"], research: ["read"] },
} as UnifiedWorkspace;
const secret = "pum_" + "S".repeat(43);
const issued: UnifiedIssued = {
  id: "issued",
  name: "我的 Agent",
  scope: {
    include_future_objects: true,
    workspaces: [{ workspace_id: "one", domains: { administrative: "read", research: "read_write" } }],
  },
  implemented_capabilities: ["read", "research_write"],
  created_at: "2026-10-29T00:00:00Z",
  expires_at: "2030-01-01T00:00:00Z",
  last_used_at: null,
  revoked_at: null,
  secret,
  mcp_url: "https://plane.test/api/mcp/",
  codex_toml: "unused-server-toml",
  sciencediscovery_json: JSON.stringify({
    mcpServers: {
      plane: { type: "http", url: "https://plane.test/api/mcp/", headers: { Authorization: "Bearer " + secret } },
    },
  }),
};
const optionPage = (results = [one, two], next_cursor: string | null = null) => ({
  results,
  next_cursor,
  csrf_token: "csrf-options",
  ttl_seconds: 604800,
  max_workspaces: 20,
  write_requires_future_objects: true,
});
const connectionPage = (results: unknown[] = [], next_cursor: string | null = null) => ({
  results,
  next_cursor,
  csrf_token: "csrf-list",
});
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = "current-user";
  mocks.params = "";
  runInAction(() => {
    userState.id = "current-user";
  });
  mocks.options.mockResolvedValue(optionPage());
  mocks.connections.mockResolvedValue(connectionPage());
  mocks.issue.mockResolvedValue(issued);
  mocks.revoke.mockResolvedValue({ revoked: true });
  mocks.copy.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(node: React.ReactNode = <UnifiedMCPManager initialWorkspace="first" />) {
  await act(async () => root.render(node));
}
async function click(text: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === text || item.getAttribute("aria-label") === text
  );
  expect(button, text).toBeTruthy();
  await act(async () => button!.click());
}
async function check(label: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(input, label).toBeTruthy();
  await act(async () => input!.click());
}
async function select(label: string, value: string) {
  const input = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  expect(input, label).toBeTruthy();
  await act(async () => {
    input!.value = value;
    input!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const configText = () => container.querySelector<HTMLTextAreaElement>('[aria-label="统一 JSON 配置"]')?.value;

it("creates exactly one connection/config for both businesses and multiple workspaces, without node discovery", async () => {
  await render();
  await check("选择工作区 工作区二");
  await select("科研能力 工作区一", "read_write");
  await click("生成单份配置");
  expect(mocks.issue).toHaveBeenCalledTimes(1);
  expect(mocks.issue.mock.calls[0][0]).toEqual({
    name: "我的 Agent",
    include_future_objects: true,
    workspaces: [
      { workspace_id: "one", domains: { administrative: "read", research: "read_write" } },
      { workspace_id: "two", domains: { administrative: "read", research: "read" } },
    ],
  });
  expect(mocks.issue.mock.calls[0][1]).toMatch(/^csrf-/);
  expect(Object.keys(JSON.parse(configText()!).mcpServers)).toEqual(["plane"]);
  const toml = container.querySelector<HTMLTextAreaElement>('[aria-label="统一 TOML 配置"]')!.value;
  expect(toml.match(/\[mcp_servers\./g)).toHaveLength(1);
  expect(toml).toContain(secret);
  expect(mocks.options).toHaveBeenCalledTimes(1);
  await click("生成单份配置");
  expect(mocks.issue).toHaveBeenCalledTimes(1);
});

it("defaults to read, reports unavailable research writes, and requires dynamic scope for write", async () => {
  await render();
  await check("选择工作区 工作区二");
  expect(
    container.querySelector<HTMLOptionElement>('[aria-label="科研能力 工作区二"] option[value="read_write"]')?.disabled
  ).toBe(true);
  await check("包含未来新增且有权限的内容");
  await select("行政能力 工作区一", "read_write");
  await click("生成单份配置");
  expect(mocks.issue).not.toHaveBeenCalled();
  expect(container.textContent).toContain("读写连接需要动态范围");
  await select("行政能力 工作区一", "read");
  await click("生成单份配置");
  expect(mocks.issue.mock.calls[0][0].include_future_objects).toBe(false);
});

it("keeps the unified workflow without a legacy entry and ignores legacy URL credentials", async () => {
  mocks.params = "workspace=second&node=old-node&token=old-secret";
  await render(<MCPManagement workspaceSlug="first" inModal />);
  expect(container.textContent).not.toContain("旧连接管理已加载");
  expect(container.querySelector<HTMLInputElement>('[aria-label="选择工作区 工作区一"]')?.checked).toBe(true);
  expect(container.textContent).not.toContain("old-secret");
  expect(container.querySelector("summary")).toBeNull();
  expect(container.textContent).not.toContain("兼容与精细范围连接");
  expect(container.textContent).not.toContain("展开下方兼容区域");
  await click("生成单份配置");
  expect(mocks.issue).toHaveBeenCalledTimes(1);
  expect(configText()).toContain(secret);
});

it("clears credentials on close, scope changes, and reload; never puts issuance secrets in list metadata", async () => {
  const storage = vi.spyOn(Storage.prototype, "setItem");
  await render();
  await click("生成单份配置");
  expect(configText()).toContain(secret);
  expect(JSON.stringify(unifiedMetadata(issued))).not.toContain(secret);
  await click("关闭配置并清除密钥");
  expect(configText()).toBeUndefined();
  expect(container.textContent).not.toContain(secret);
  await click("生成单份配置");
  expect(mocks.issue).toHaveBeenCalledTimes(1);
  await click("新建另一条连接");
  await click("生成单份配置");
  await select("行政能力 工作区一", "none");
  expect(configText()).toBeUndefined();
  expect(storage).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(configText()).toBeUndefined();
  storage.mockRestore();
});

it("pages workspace and connection lists without guessing missing targets and retains rows on page failures", async () => {
  mocks.options.mockImplementation(async (cursor?: string) =>
    cursor ? optionPage([two]) : optionPage([one], "workspaces-next")
  );
  mocks.connections.mockImplementation(async (cursor?: string) =>
    cursor
      ? connectionPage([{ ...unifiedMetadata(issued), id: "second-record", name: "历史连接" }])
      : connectionPage([unifiedMetadata(issued)], "connections-next")
  );
  await render();
  expect(container.textContent).not.toContain("工作区二");
  await click("加载更多工作区");
  expect(mocks.options).toHaveBeenLastCalledWith("workspaces-next");
  expect(container.textContent).toContain("工作区二");
  mocks.connections.mockRejectedValueOnce({ status: 503 });
  await click("加载更多连接");
  expect(container.querySelector('[aria-label="统一连接 我的 Agent"]')).toBeTruthy();
  await click("重试连接列表");
  expect(mocks.connections).toHaveBeenLastCalledWith("connections-next");
  expect(container.textContent).toContain("历史连接");
});

it("keeps a connection after revoke failure and marks it revoked only after explicit successful confirmation", async () => {
  mocks.connections.mockResolvedValue(connectionPage([unifiedMetadata(issued)]));
  await render();
  await click("撤销统一连接：我的 Agent");
  expect(mocks.revoke).not.toHaveBeenCalled();
  mocks.revoke.mockRejectedValueOnce({ status: 503 });
  await click("确认撤销");
  expect(container.querySelector('[role="dialog"]')).toBeTruthy();
  expect(container.textContent).not.toContain("已撤销");
  await click("确认撤销");
  expect(mocks.revoke).toHaveBeenLastCalledWith("issued", expect.stringMatching(/^csrf-/));
  expect(container.textContent).toContain("已撤销");
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it("does not automatically repeat an uncertain issuance and requires checking the connection list", async () => {
  mocks.issue.mockRejectedValueOnce({ status: 503 });
  await render();
  await click("生成单份配置");
  await click("生成单份配置");
  expect(mocks.issue).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("签发结果尚未确认");
  await select("行政能力 工作区一", "none");
  expect(container.textContent).toContain("签发结果尚未确认");
  await click("已核对列表，重新生成");
  await click("生成单份配置");
  expect(mocks.issue).toHaveBeenCalledTimes(2);
});

it.each(["", "   ", "invalid" + String.fromCharCode(1)])(
  "rejects invalid connection name %j before sending a creation request",
  async (name) => {
    await render();
    const input = container.querySelector<HTMLInputElement>('[aria-label="统一连接名称"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("生成单份配置");
    expect(mocks.issue).not.toHaveBeenCalled();
  }
);

it("does not double-submit a pending request or expose its late secret after changing workspace context", async () => {
  let resolve!: (value: UnifiedIssued) => void;
  mocks.issue.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    })
  );
  await render();
  await click("生成单份配置");
  await click("正在处理…");
  expect(mocks.issue).toHaveBeenCalledTimes(1);
  await render(<UnifiedMCPManager initialWorkspace="second" />);
  await act(async () => resolve(issued));
  expect(configText()).toBeUndefined();
  expect(container.textContent).not.toContain(secret);
  expect(container.querySelector<HTMLInputElement>('[aria-label="选择工作区 工作区二"]')?.checked).toBe(true);
});

it("clears issued credentials when the signed-in owner changes", async () => {
  await render(<MCPManagement workspaceSlug="first" />);
  await click("生成单份配置");
  expect(configText()).toContain(secret);
  await act(async () =>
    runInAction(() => {
      userState.id = "different-user";
    })
  );
  expect(configText()).toBeUndefined();
});

it("keeps a successful but malformed issuance as success metadata and never exposes parser source text", async () => {
  mocks.issue.mockResolvedValue({ ...issued, sciencediscovery_json: '{"secret":"PARSER-CANARY"' });
  await render();
  await click("生成单份配置");
  await click("生成单份配置");
  expect(mocks.issue).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("连接已生成，但配置格式无法识别");
  expect(container.textContent).not.toContain("PARSER-CANARY");
  expect(container.querySelector('[aria-label="统一连接 我的 Agent"]')).toBeTruthy();
});

it.each(["multiple", "wrong-header", "wrong-path"])(
  "rejects %s configs instead of bundling old credentials",
  (kind) => {
    const data = JSON.parse(issued.sciencediscovery_json);
    if (kind === "multiple") data.mcpServers.second = data.mcpServers.plane;
    if (kind === "wrong-header") data.mcpServers.plane.headers = { "X-Research-Context-Token": "old" };
    const value = {
      ...issued,
      ...(kind === "wrong-path" ? { mcp_url: "https://plane.test/api/mcp/native/" } : {}),
      sciencediscovery_json: JSON.stringify(data),
    };
    expect(() => unifiedConfiguration(value)).toThrow("连接已生成，但配置格式无法识别");
  }
);
