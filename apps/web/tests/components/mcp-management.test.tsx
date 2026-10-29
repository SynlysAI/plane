// @vitest-environment jsdom
/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { act, startTransition, Suspense } from "react";
import { renderToString } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  candidates: vi.fn(),
  connections: vi.fn(),
  issue: vi.fn(),
  revoke: vi.fn(),
  fetch: vi.fn(),
  query: "",
  profileTabId: "mcp",
  setParams: vi.fn(),
}));
vi.mock("@plane/propel/button", () => ({
  Button: ({ children, variant: _v, size: _s, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock("@plane/ui", () => ({
  AlertModalCore: ({ isOpen, title, content, handleSubmit, handleClose, isSubmitting }: any) =>
    isOpen ? (
      <div role="dialog">
        <h2>{title}</h2>
        {content}
        <button disabled={isSubmitting} onClick={handleSubmit}>
          确认撤销
        </button>
        <button onClick={handleClose}>取消</button>
      </div>
    ) : null,
}));
vi.mock("@plane/utils", () => ({ copyTextToClipboard: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/services/mcp.service", () => ({
  NativeMCPService: class {
    read = mocks.read;
    write = mocks.write;
  },
  ResearchMCPService: class {
    candidates = mocks.candidates;
    connections = mocks.connections;
    issue = mocks.issue;
    revoke = mocks.revoke;
  },
}));
const workspaceStore = {
  workspaces: {
    one: { id: "one", slug: "public", name: "Public" },
    two: { id: "two", slug: "second", name: "Second" },
  },
  currentWorkspace: { slug: "public" },
  fetchWorkspaces: mocks.fetch,
};
vi.mock("@/hooks/store/use-workspace", () => ({ useWorkspace: () => workspaceStore }));
vi.mock("@/hooks/store/use-command-palette", () => ({
  useCommandPalette: () => ({ profileSettingsModal: { isOpen: true } }),
}));
vi.mock("@/hooks/store/user", () => ({
  useUser: () => ({ data: { display_name: "Local researcher", id: "internal-local-user-id" } }),
}));
vi.mock("@/components/core/page-title", () => ({ PageHead: () => null }));
vi.mock("react-router", () => ({
  useSearchParams: () => [new URLSearchParams(mocks.query), mocks.setParams],
  Navigate: ({ to, replace }: any) => <div data-to={to} data-replace={replace} />,
}));
import { MCPManagement } from "@/components/mcp/mcp-management";
import { NativeMCPManager } from "@/components/mcp/native-mcp-manager";
import { emptyNative } from "@/components/mcp/mcp-services";
import { MCPProfileSettings } from "@/components/settings/profile/content/pages/mcp";
import { MCPManagementRedirect } from "@/components/mcp/mcp-management-redirect";
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const options = {
  workspaces: ["public", "denied"],
  allow_publish: false,
  max_token_days: 7,
  plane_ui_url: "https://remote.test",
  csrf_token: "plane-csrf",
  portal_url: "https://native.test/connect",
};
const n1 = {
  id: "node-1",
  chain_id: "chain-1",
  title: "First",
  status: "ACTIVE",
  actions: [],
  write_unavailable_reason: "写入未开放",
};
const n2 = { ...n1, id: "node-2", title: "Second node" };
const page = (results: unknown[], next_cursor: string | null = null) => ({
  results,
  next_cursor,
  csrf_token: "research-csrf",
  ttl_seconds: 604800,
});
const nativeIssued = {
  id: "a".repeat(32),
  workspace: "public",
  label: "Agent",
  expires: 2000000000,
  mcp_url: "https://native.test/mcp",
  sciencediscovery_json: JSON.stringify({
    mcpServers: { old: { url: "https://native.test/mcp", headers: { Authorization: "Bearer ADMIN-SECRET" } } },
  }),
};
const researchIssued = (node: string) => ({
  id: node,
  expires_at: "2030-01-01T00:00:00Z",
  mcp_path: "/api/research/workspaces/public/agent-access/mcp/",
  headers: { "X-Research-Context-Token": `SECRET-${node}`, "X-Research-Context-Hash": "hash" },
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query = "";
  mocks.fetch.mockResolvedValue([]);
  mocks.read.mockImplementation(async (action) =>
    action === "options"
      ? options
      : action === "session"
        ? { name: "Independent user", csrf: "native-csrf" }
        : action === "candidates"
          ? { workspaces: ["public"], failures: [], account: { id: "remote-user" } }
          : { tokens: [] }
  );
  mocks.write.mockResolvedValue(nativeIssued);
  mocks.candidates.mockImplementation(async (_workspace, params) =>
    params?.chain_id ? page([n1, n2]) : page([{ id: "chain-1", title: "Research", status: "ACTIVE" }])
  );
  mocks.connections.mockResolvedValue(page([]));
  mocks.issue.mockImplementation(async (_workspace, data) => researchIssued(data.node_id));
  mocks.revoke.mockResolvedValue({ revoked: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(element: React.ReactNode = <MCPManagement workspaceSlug="public" />) {
  await act(async () => root.render(element));
}
async function click(text: string) {
  const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === text || button.getAttribute("aria-label") === text
  )!;
  expect(element, text).toBeTruthy();
  await act(async () => element.click());
}
async function check(label: string) {
  const element = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(element, label).toBeTruthy();
  await act(async () => element.click());
}
async function nodes() {
  await click("Research · ACTIVE");
}

it("unifies both businesses, lazy-loads permission-filtered chains/nodes and does not duplicate workspace selectors", async () => {
  mocks.query = "mode=research&node=secret-node&token=secret";
  await render(<MCPProfileSettings inModal />);
  expect(container.textContent).toContain("行政项目接入");
  expect(container.textContent).toContain("科研链 / 科研节点");
  expect(container.textContent).toContain("https://remote.test");
  expect(container.textContent).toContain("独立验证");
  expect(container.querySelector("select")).toBeNull();
  expect(container.querySelector('[aria-label="行政项目访问 denied"]')).toBeNull();
  expect(mocks.candidates).toHaveBeenCalledWith("public", { q: "", cursor: undefined });
  expect(mocks.candidates.mock.calls.some(([, params]) => params?.chain_id)).toBe(false);
  await nodes();
  await check("选择节点 First");
  expect(container.querySelector<HTMLInputElement>('[aria-label="受控写入 First"]')?.disabled).toBe(true);
  expect(container.querySelector('[aria-label="授权摘要"]')?.textContent).toContain("Research / First · 只读");
  expect(mocks.setParams).not.toHaveBeenCalled();
});

it.each([false, true])(
  "hides internal identity IDs and limits native result text to account/capability/expiry (write=%s)",
  async (write) => {
    const read = mocks.read.getMockImplementation()!;
    const identityId = "11111111-2222-4333-8444-555555555555";
    mocks.read.mockImplementation(async (action) => {
      if (action === "options") return { ...options, allow_publish: write };
      if (action === "candidates") return { workspaces: ["public"], failures: [], account: { id: identityId } };
      return read(action);
    });
    await render();
    const identity = container.querySelector('[aria-label="行政身份验证"]')!;
    expect(identity.textContent).toContain("已验证行政服务账号：Independent user");
    expect(identity.innerHTML).not.toContain(identityId);
    await check("行政项目访问 public");
    if (write) {
      const label = [...container.querySelectorAll("label")].find((item) =>
        item.textContent?.includes("允许准备并发布行政进展评论")
      )!;
      await act(async () => label.querySelector<HTMLInputElement>("input")!.click());
    }
    const summary = container.querySelector('[aria-label="授权摘要"]')!;
    expect(summary.textContent).toContain("行政账号 Independent user");
    expect(summary.innerHTML).not.toContain(identityId);
    await click("批量生成独立连接");
    const result = container.querySelector('[aria-label="批量生成结果"] p[role="status"]')!;
    expect(result.textContent).toBe(
      `账号：Independent user · ${write ? "读写（进展发布）" : "只读"} · 到期时间：${new Date(nativeIssued.expires * 1000).toLocaleString()}`
    );
    expect(result.textContent).not.toContain(identityId);
    expect(result.textContent).not.toContain(nativeIssued.id);
    expect(result.textContent).not.toContain("服务项");
    expect(result.textContent).not.toContain("public");
    const config = JSON.parse(container.querySelector<HTMLTextAreaElement>('[aria-label="批量 JSON 配置"]')!.value);
    expect(Object.keys(config.mcpServers)).toEqual([`plane_admin_${nativeIssued.id}`]);
  }
);

it("groups administrative and research connections outside the target picker and filters without reloading", async () => {
  const read = mocks.read.getMockImplementation()!;
  mocks.read.mockImplementation(async (action) =>
    action === "tokens" ? { tokens: [{ ...nativeIssued, label: "Admin existing" }] } : read(action)
  );
  mocks.connections.mockImplementation(async (workspace) =>
    page(
      workspace === "public"
        ? [
            {
              ...researchIssued("research-existing"),
              workspace,
              label: "Research existing",
              chain_title: "Research",
              node_title: "First",
              mode: "read",
              actions: [],
              created_at: "2026-10-21T00:00:00Z",
              last_used_at: null,
              revoked_at: null,
            },
          ]
        : []
    )
  );
  await render(<MCPManagement />);
  const existing = container.querySelector('[aria-label="已有连接"]')!;
  const picker = container.querySelector('[aria-label="工作区与能力选择"]')!;
  const administrative = existing.querySelector('[aria-label="已有行政连接"]')!;
  const research = existing.querySelector('[aria-label="科研连接 Public"]')!;
  expect(administrative.textContent).toContain("Admin existing");
  expect(research.textContent).toContain("Research existing");
  expect(picker.textContent).not.toContain("Research existing");
  expect(picker.querySelector("article")).toBeNull();
  expect(mocks.candidates).not.toHaveBeenCalled();
  const requests = mocks.connections.mock.calls.length;
  await click("行政连接");
  expect(research.parentElement!.hidden).toBe(true);
  expect(administrative.parentElement!.hidden).toBe(false);
  await click("科研连接");
  expect(research.parentElement!.hidden).toBe(false);
  expect(administrative.parentElement!.hidden).toBe(true);
  await click("全部连接");
  await click("Public · 本实例科研");
  await click("Public · 本实例科研");
  const search = container.querySelector<HTMLInputElement>('[aria-label="搜索连接目标"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "not-a-connection-filter");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("搜索");
  expect(mocks.connections).toHaveBeenCalledTimes(requests);
  expect(existing.textContent).toContain("Research existing");
});

it.each([false, true])(
  "omits empty research workspace groups, including revoked-only lists (revoked=%s)",
  async (revoked) => {
    mocks.connections.mockImplementation(async (workspace) =>
      page(
        workspace === "public" && revoked
          ? [
              {
                ...researchIssued("revoked-grant"),
                workspace,
                label: "Revoked research",
                chain_title: "Research",
                node_title: "First",
                mode: "read",
                actions: [],
                created_at: "2026-10-21T00:00:00Z",
                last_used_at: null,
                revoked_at: "2026-10-22T00:00:00Z",
              },
            ]
          : []
      )
    );
    await render();
    expect(container.querySelector('[aria-label="科研连接 Public"]')).toBeNull();
    expect(container.querySelector('[aria-label="科研连接 Second"]')).toBeNull();
    expect(container.textContent).not.toContain("尚无科研节点连接");
    expect(container.textContent).not.toContain("Revoked research");
    expect(container.querySelector('[aria-label="科研工作区 Public"]')).not.toBeNull();
  }
);

it("retains initial research list errors and hides the group only after a successful empty retry", async () => {
  mocks.connections.mockImplementation(async (workspace) => {
    if (workspace === "public") throw { status: 500, message: "连接列表暂不可用" };
    return page([]);
  });
  await render();
  const section = container.querySelector('[aria-label="科研连接 Public"]')!;
  expect(section.querySelector('[role="alert"]')?.textContent).toContain("连接列表暂不可用");
  mocks.connections.mockResolvedValue(page([]));
  await click("重试连接列表");
  expect(container.querySelector('[aria-label="科研连接 Public"]')).toBeNull();
});

it("keeps pagination available when the first research page has only revoked records", async () => {
  const connection = {
    ...researchIssued("stored-grant"),
    workspace: "public",
    label: "Found connection",
    chain_title: "Research",
    node_title: "First",
    mode: "read",
    actions: [],
    created_at: "2026-10-21T00:00:00Z",
    last_used_at: null,
    revoked_at: null,
  };
  mocks.connections.mockImplementation(async (workspace, cursor) => {
    if (workspace !== "public") return page([]);
    return cursor
      ? page([connection])
      : page([{ ...connection, label: "Revoked connection", revoked_at: "2026-10-22T00:00:00Z" }], "next-connections");
  });
  await render();
  expect(container.textContent).not.toContain("Revoked connection");
  await click("加载更多科研连接");
  expect(container.querySelector('[aria-label="科研连接 Public"]')?.textContent).toContain("Found connection");
  expect(mocks.connections).toHaveBeenLastCalledWith("public", "next-connections");
});

it("loads existing connections independently for closed workspaces and isolates delayed responses", async () => {
  let resolve!: (value: unknown) => void;
  const connection = (workspace: string, label: string) => ({
    ...researchIssued(label),
    workspace,
    label,
    chain_title: "Research",
    node_title: "Node",
    mode: "read",
    actions: [],
    created_at: "2026-10-21T00:00:00Z",
    last_used_at: null,
    revoked_at: null,
  });
  mocks.connections.mockImplementation(async (workspace) =>
    workspace === "public"
      ? new Promise((done) => {
          resolve = done;
        })
      : page([connection("second", "Second workspace connection")])
  );
  await render(<MCPManagement />);
  expect(mocks.candidates).not.toHaveBeenCalled();
  const first = container.querySelector('[aria-label="科研连接 Public"]')!;
  const second = container.querySelector('[aria-label="科研连接 Second"]')!;
  expect(second.textContent).toContain("Second workspace connection");
  expect(first.textContent).not.toContain("Second workspace connection");
  await act(async () =>
    resolve(page([connection("public", "Public connection"), connection("second", "Wrong workspace record")]))
  );
  expect(first.textContent).toContain("Public connection");
  expect(second.textContent).not.toContain("Public connection");
  expect(container.textContent).not.toContain("Wrong workspace record");
});

it("retries a failed existing-connections page without losing earlier records", async () => {
  let failed = false;
  const connection = (label: string) => ({
    ...researchIssued(label),
    workspace: "public",
    label,
    chain_title: "Research",
    node_title: "Node",
    mode: "read",
    actions: [],
    created_at: "2026-10-21T00:00:00Z",
    last_used_at: null,
    revoked_at: null,
  });
  mocks.connections.mockImplementation(async (workspace, cursor) => {
    if (workspace !== "public") return page([]);
    if (!cursor) return page([connection("First page connection")], "more-connections");
    if (!failed) {
      failed = true;
      throw { status: 500, message: "下一页暂时不可用" };
    }
    return page([connection("Second page connection")]);
  });
  await render();
  await click("加载更多科研连接");
  expect(container.textContent).toContain("下一页暂时不可用");
  expect(container.textContent).toContain("First page connection");
  await click("重试连接列表");
  expect(container.textContent).toContain("First page connection");
  expect(container.textContent).toContain("Second page connection");
  expect(mocks.connections).toHaveBeenLastCalledWith("public", "more-connections");
});

it("loads every page explicitly and chain selection never includes unloaded nodes", async () => {
  mocks.candidates.mockImplementation(async (_workspace, params) =>
    !params?.chain_id
      ? page([{ id: "chain-1", title: "Research", status: "ACTIVE" }])
      : params.cursor
        ? page([n2])
        : page([n1], "next-nodes")
  );
  await render();
  await nodes();
  await act(async () =>
    container.querySelector<HTMLInputElement>('label input[type="checkbox"]:not([aria-label])')!.click()
  );
  expect(container.querySelector('[aria-label="授权摘要"]')?.textContent).toContain("1 个科研节点");
  await click("加载更多节点（未加载节点不会被全选）");
  expect(container.querySelector<HTMLInputElement>('[aria-label="选择节点 Second node"]')!.checked).toBe(false);
  expect(mocks.candidates).toHaveBeenCalledWith("public", { chain_id: "chain-1", q: "", cursor: "next-nodes" });
});

it("records mixed batch failures and retries only failed targets with distinct named configuration", async () => {
  let failed = false;
  mocks.issue.mockImplementation(async (_workspace, data) => {
    if (data.node_id === "node-2" && !failed) {
      failed = true;
      throw { status: 403, message: "节点权限已变化" };
    }
    return researchIssued(data.node_id);
  });
  await render();
  await nodes();
  await check("行政项目访问 public");
  await check("选择节点 First");
  await check("选择节点 Second node");
  await click("批量生成独立连接");
  expect(container.textContent).toContain("2 成功、1 失败");
  expect(container.textContent).toContain("节点权限已变化");
  const resultRows = container.querySelectorAll('[aria-label="批量生成结果"] p[role]');
  expect(resultRows[1].textContent).toBe(
    `账号：Local researcher · 只读 · 到期时间：${new Date(researchIssued("node-1").expires_at).toLocaleString()}`
  );
  expect(resultRows[2].getAttribute("role")).toBe("alert");
  expect(resultRows[2].textContent).toContain("未签发");
  expect(resultRows[2].textContent).toContain("节点权限已变化");
  expect(mocks.write).toHaveBeenCalledTimes(1);
  expect(mocks.issue).toHaveBeenCalledTimes(2);
  await click("重试未成功目标");
  expect(mocks.write).toHaveBeenCalledTimes(1);
  expect(mocks.issue).toHaveBeenCalledTimes(3);
  const config = JSON.parse(container.querySelector<HTMLTextAreaElement>('[aria-label="批量 JSON 配置"]')!.value);
  expect(Object.keys(config.mcpServers)).toHaveLength(3);
  expect(Object.keys(config.mcpServers)).toContain(`plane_admin_${"a".repeat(32)}`);
  expect(mocks.issue.mock.calls[0][1]).toMatchObject({ mode: "read", actions: [] });
  await click("关闭生成结果并清除密钥");
  expect(container.querySelector("textarea")).toBeNull();
  await click("批量生成独立连接");
  expect(mocks.issue).toHaveBeenCalledTimes(3);
});

it("clears secrets on target changes and ignores a delayed result after the active workspace changes", async () => {
  let resolve!: (value: unknown) => void;
  mocks.issue.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  await render();
  await nodes();
  await check("选择节点 First");
  await check("选择节点 Second node");
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "批量生成独立连接")!;
  await act(async () => button.click());
  await render(<MCPManagement workspaceSlug="second" />);
  await act(async () => resolve(researchIssued("node-1")));
  expect(container.querySelector("textarea")).toBeNull();
  expect(mocks.issue).toHaveBeenCalledTimes(1);
});

it("shows permission failures with retry without claiming an empty successful result", async () => {
  mocks.candidates.mockRejectedValueOnce({ status: 403, message: "科研权限不足" });
  await render();
  expect(container.textContent).toContain("科研权限不足");
  await click("重试科研候选");
  expect(container.textContent).toContain("Research · ACTIVE");
});

it("requires explicit confirmation and preserves a connection on revocation failure", async () => {
  let revoked = false;
  mocks.connections.mockImplementation(async () =>
    page([
      {
        ...researchIssued("grant"),
        workspace: "public",
        label: "Existing",
        node_title: "First",
        chain_title: "Research",
        mode: "read",
        actions: [],
        created_at: "2026-01-01",
        revoked_at: revoked ? "2026-10-22T00:00:00Z" : null,
        last_used_at: null,
      },
    ])
  );
  mocks.revoke.mockImplementation(async () => {
    revoked = true;
    return { revoked: true };
  });
  mocks.revoke.mockRejectedValueOnce({ status: 403, message: "不能撤销此连接" });
  await render();
  await click("撤销科研连接：Existing");
  expect(mocks.revoke).not.toHaveBeenCalled();
  await click("确认撤销");
  expect(container.textContent).toContain("不能撤销此连接");
  expect(container.textContent).toContain("Existing");
  await click("确认撤销");
  expect(mocks.revoke).toHaveBeenLastCalledWith("public", "grant", "research-csrf");
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).not.toContain("Existing");
  expect(container.querySelector('[aria-label="科研连接 Public"]')).toBeNull();
  expect(container.textContent).not.toContain("尚无科研节点连接。");
});

it("hides previously revoked connections on every page and shows only the four requested detail fields", async () => {
  const connection = {
    ...researchIssued("private-grant-id"),
    workspace: "public",
    label: "Visible connection",
    node_title: "First",
    chain_title: "Research",
    mode: "write",
    actions: ["create_task"],
    created_at: "2026-10-21T01:00:00Z",
    revoked_at: null,
    last_used_at: "2026-10-22T01:00:00Z",
  };
  mocks.connections.mockImplementation(async (_workspace, cursor) =>
    cursor
      ? page([
          { ...connection, id: "revoked-on-page-two", label: "Revoked later page", revoked_at: "2026-10-22T00:00:00Z" },
        ])
      : page(
          [
            { ...connection, id: "revoked-first-page", label: "Already revoked", revoked_at: "2026-10-22T00:00:00Z" },
            connection,
          ],
          "more-connections"
        )
  );
  await render();
  const details = container.querySelector('[aria-label="科研连接 Public"] details')!;
  expect(details.textContent).toContain("工作区：public");
  expect(details.textContent).toContain("创建时间：");
  expect(details.textContent).toContain("到期时间：");
  expect(details.textContent).toContain("最近使用时间：");
  expect(details.textContent).not.toContain("private-grant-id");
  expect(details.textContent).not.toContain("授权 ID");
  expect(details.textContent).not.toContain("能力");
  expect(container.textContent).not.toContain("Already revoked");
  await click("加载更多科研连接");
  expect(container.textContent).not.toContain("Revoked later page");
  expect(container.textContent).toContain("Visible connection");
});

it("hides revoked administrative connections and omits IDs from their details", async () => {
  const read = mocks.read.getMockImplementation()!;
  const token = { ...nativeIssued, created: 1760000000, last_used: 1760000100 };
  mocks.read.mockImplementation(async (action) =>
    action === "tokens"
      ? {
          tokens: [
            { ...token, id: "revoked-admin-id", label: "Revoked administrative connection", revoked: true },
            token,
            { ...token, id: "expired-admin-id", label: "Expired administrative connection", expires: 1 },
          ],
        }
      : read(action)
  );
  await render();
  const section = container.querySelector('[aria-label="已有行政连接"]')!;
  expect(section.textContent).not.toContain("Revoked administrative connection");
  expect(section.textContent).not.toContain("已撤销");
  expect(section.textContent).toContain("Agent");
  expect(section.textContent).toContain("Expired administrative connection");
  expect(section.textContent).toContain("已到期");
  const details = section.querySelector("details")!;
  expect(details.textContent).toContain("工作区：public");
  expect(details.textContent).toContain("创建时间：");
  expect(details.textContent).toContain("到期时间：");
  expect(details.textContent).toContain("最近使用时间：");
  expect(details.textContent).not.toContain("连接 ID");
  expect(details.textContent).not.toContain(token.id);
});

it("keeps administrative cards on revocation failure and removes them after confirmed success", async () => {
  let revoked = false;
  const read = mocks.read.getMockImplementation()!;
  mocks.read.mockImplementation(async (action) =>
    action === "tokens" ? { tokens: [{ ...nativeIssued, revoked }] } : read(action)
  );
  mocks.write.mockRejectedValueOnce({ status: 403, message: "不能撤销此行政连接" });
  mocks.write.mockImplementation(async () => {
    revoked = true;
    return { revoked: true };
  });
  await render();
  await click("撤销行政连接：Agent");
  expect(mocks.write).not.toHaveBeenCalled();
  await click("确认撤销");
  expect(container.textContent).toContain("不能撤销此行政连接");
  expect(container.querySelector('[aria-label="已有行政连接"]')?.textContent).toContain("Agent");
  await click("确认撤销");
  expect(mocks.write).toHaveBeenLastCalledWith(`tokens/${nativeIssued.id}/revoke`, {}, "plane-csrf", "native-csrf");
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  const section = container.querySelector('[aria-label="已有行政连接"]')!;
  expect(section.textContent).not.toContain("Agent");
  expect(section.querySelector("details")).toBeNull();
  expect(section.textContent).toContain("尚无行政连接。");
});

it("keeps native PAT out of state output and uses independent CSRF values", async () => {
  let authenticated = false;
  mocks.read.mockImplementation(async (action) => {
    if (action === "options") return options;
    if (action === "session") {
      if (!authenticated) throw { status: 401 };
      return { name: "Independent user", csrf: "native-csrf" };
    }
    return action === "candidates"
      ? { workspaces: ["public"], failures: [], account: { id: "remote" } }
      : { tokens: [] };
  });
  mocks.write.mockImplementation(async (action) => {
    if (action === "login") authenticated = true;
    return {};
  });
  await render();
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  input.value = "PRIVATE-PAT";
  await act(async () => input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(mocks.write).toHaveBeenCalledWith("login", { plane_token: "PRIVATE-PAT" }, "plane-csrf", "");
  expect(container.innerHTML).not.toContain("PRIVATE-PAT");
  expect(container.textContent).toContain("Independent user");
});

it("keeps legacy links compatible and strips historical machine credentials", async () => {
  mocks.query = "token=secret&node=old&operation=old";
  await render(<MCPManagementRedirect workspaceSlug="public" />);
  expect(container.querySelector("[data-to]")?.getAttribute("data-to")).toBe("/settings/profile/mcp/?workspace=public");
});

it("keeps identities with the same display name isolated without rendering their IDs", async () => {
  let authenticated = true;
  let identityId = "internal-first-account-id";
  mocks.read.mockImplementation(async (action) => {
    if (action === "options") return options;
    if (action === "session") {
      if (!authenticated) throw { status: 401 };
      return { name: "Same display name", csrf: "native-csrf" };
    }
    return action === "candidates"
      ? { workspaces: ["public"], failures: [], account: { id: identityId } }
      : { tokens: [] };
  });
  mocks.write.mockImplementation(async (action) => {
    if (action === "logout") authenticated = false;
    if (action === "login") {
      authenticated = true;
      identityId = "internal-second-account-id";
    }
    return nativeIssued;
  });
  await render();
  await check("行政项目访问 public");
  await click("批量生成独立连接");
  await click("退出行政接入");
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  input.value = "SYNTHETIC-SECOND-ACCOUNT-PAT";
  await act(async () => input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await check("行政项目访问 public");
  await click("批量生成独立连接");
  expect(mocks.write.mock.calls.filter(([action]) => action === "tokens")).toHaveLength(2);
  expect(container.textContent).not.toContain("internal-first-account-id");
  expect(container.textContent).not.toContain("internal-second-account-id");
});

it("does not reissue a successful administrative target after the same independent identity reauthenticates", async () => {
  let authenticated = true;
  let nodeFailed = false;
  mocks.read.mockImplementation(async (action) => {
    if (action === "options") return options;
    if (action === "session") {
      if (!authenticated) throw { status: 401 };
      return { name: "Independent user", csrf: authenticated ? "native-csrf" : "" };
    }
    return action === "candidates"
      ? { workspaces: ["public"], failures: [], account: { id: "stable-actor" } }
      : { tokens: [] };
  });
  mocks.write.mockImplementation(async (action) => {
    if (action === "logout") authenticated = false;
    if (action === "login") authenticated = true;
    return nativeIssued;
  });
  mocks.issue.mockImplementation(async (_workspace, data) => {
    if (!nodeFailed) {
      nodeFailed = true;
      throw { status: 403, message: "Retry this node" };
    }
    return researchIssued(data.node_id);
  });
  await render();
  await nodes();
  await check("行政项目访问 public");
  await check("选择节点 First");
  await click("批量生成独立连接");
  expect(mocks.write.mock.calls.filter(([action]) => action === "tokens")).toHaveLength(1);
  await click("退出行政接入");
  expect(container.querySelector("textarea")).toBeNull();
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  input.value = "REAUTH-SYNTHETIC-PAT";
  await act(async () => input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await check("行政项目访问 public");
  await click("重试未成功目标");
  expect(mocks.write.mock.calls.filter(([action]) => action === "tokens")).toHaveLength(1);
  expect(mocks.issue).toHaveBeenCalledTimes(2);
});

it.each(["", "0", "1.5", "8", "invalid"])("rejects lifetime input %s and recovers with valid days", async (invalid) => {
  await render();
  await check("行政项目访问 public");
  const input = container.querySelector<HTMLInputElement>('[aria-label="行政连接有效天数"]')!;
  async function enter(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await enter(invalid);
  await click("批量生成独立连接");
  expect(mocks.write).not.toHaveBeenCalled();
  expect(container.textContent).toContain("请输入 1 至 7 之间的整数天数");
  await enter("2");
  await click("批量生成独立连接");
  expect(mocks.write).toHaveBeenCalledWith("tokens", expect.objectContaining({ days: 2 }), "plane-csrf", "native-csrf");
});

it("retains a successful receipt when its configuration is invalid without leaking or reissuing", async () => {
  mocks.write.mockResolvedValue({ ...nativeIssued, sciencediscovery_json: '{"secret":"SYNTHETIC-CONFIG-SECRET"' });
  await render();
  await check("行政项目访问 public");
  await click("批量生成独立连接");
  expect(container.textContent).toContain("1 成功、0 失败");
  expect(container.textContent).toContain("服务返回的配置格式无法识别");
  expect(container.innerHTML).not.toContain("SYNTHETIC-CONFIG-SECRET");
  expect(container.querySelector("textarea")).toBeNull();
  await click("批量生成独立连接");
  expect(mocks.write).toHaveBeenCalledTimes(1);
});

it("renders a configured native source without browser globals during server rendering", () => {
  vi.stubGlobal("window", undefined);
  try {
    const markup = renderToString(
      <NativeMCPManager
        state={{ ...emptyNative, options }}
        onChange={vi.fn()}
        onInvalidate={vi.fn()}
        refreshVersion={0}
        disabled={false}
      />
    );
    expect(markup).toContain("https://remote.test");
    expect(markup).toContain("正在确认来源");
  } finally {
    vi.unstubAllGlobals();
  }
});

it("keeps portal callbacks from the committed render when a new render is suspended", async () => {
  let resolveOptions!: (value: typeof options) => void;
  const read = mocks.read.getMockImplementation()!;
  mocks.read.mockImplementation((action) =>
    action === "options"
      ? new Promise((done) => {
          resolveOptions = done;
        })
      : read(action)
  );
  const committed = vi.fn();
  const speculative = vi.fn();
  const suspended = new Promise(() => {});
  function Gate({ block }: { block: boolean }) {
    if (block) throw suspended;
    return null;
  }
  function View({ block, onChange }: { block: boolean; onChange: typeof committed }) {
    return (
      <Suspense fallback={<p>Suspended</p>}>
        <NativeMCPManager
          state={{ ...emptyNative, options }}
          onChange={onChange}
          onInvalidate={vi.fn()}
          refreshVersion={0}
          disabled={false}
        />
        <Gate block={block} />
      </Suspense>
    );
  }
  await render(<View block={false} onChange={committed} />);
  await act(async () => startTransition(() => root.render(<View block onChange={speculative} />)));
  await act(async () => resolveOptions(options));
  expect(committed).toHaveBeenCalledWith(
    expect.objectContaining({ session: expect.objectContaining({ name: "Independent user" }) })
  );
  expect(speculative).not.toHaveBeenCalled();
});
