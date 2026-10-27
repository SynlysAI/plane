// @vitest-environment jsdom
import React, { act, StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { observable } from "mobx";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  options: vi.fn(),
  connections: vi.fn(),
  issue: vi.fn(),
  revoke: vi.fn(),
  copy: vi.fn(),
  download: vi.fn(),
}));
vi.mock("@plane/constants", () => ({ API_BASE_URL: "https://plane.test" }));
vi.mock("@plane/propel/button", () => ({
  Button: ({ children, variant: _variant, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock("@plane/utils", () => ({ copyTextToClipboard: mocks.copy }));
vi.mock("@plane/ui", () => ({
  AlertModalCore: ({ isOpen, title, content, handleClose, handleSubmit, isSubmitting }: any) =>
    isOpen ? (
      <div role="dialog">
        <h2>{title}</h2>
        {content}
        <button disabled={isSubmitting} onClick={handleSubmit}>
          确认撤销
        </button>
        <button disabled={isSubmitting} onClick={handleClose}>
          取消
        </button>
      </div>
    ) : null,
}));
vi.mock("@/services/weekly-report-mcp.service", () => ({
  WeeklyReportMCPService: class {
    options = mocks.options;
    connections = mocks.connections;
    issue = mocks.issue;
    revoke = mocks.revoke;
  },
}));
vi.mock("@/components/mcp/connection-download", () => ({ downloadMCPConfiguration: mocks.download }));
vi.mock("@/components/mcp/mcp-management", () => ({
  MCPManagement: ({ workspaceSlug, inModal }: any) => <p data-existing={workspaceSlug}>原连接页：{String(inModal)}</p>,
}));
const workspaceStore = observable({ currentWorkspace: { slug: "public" } });
const modalStore = observable({ profileSettingsModal: { isOpen: true } });
vi.mock("@/hooks/store/use-workspace", () => ({ useWorkspace: () => workspaceStore }));
vi.mock("@/hooks/store/use-command-palette", () => ({
  useCommandPalette: () => modalStore,
}));
import { WeeklyReportMCPSettings } from "@/components/mcp/weekly-report-settings";
import { WeeklyReportConnectionsList } from "@/components/mcp/weekly-report-connections";
import { MCPProfileSettings } from "@/components/settings/profile/content/pages/mcp";

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const workspace = (slug = "public", overrides = {}) => ({
  id: slug,
  slug,
  name: slug === "public" ? "公共工作区" : "第二工作区",
  enabled: true,
  unavailable_reason: null,
  actions: ["save_draft", "submit"],
  ttl_days: [1, 7],
  period_policy: "current_and_previous_week.v1",
  period_description: "仅本人本周与上周的周报。",
  ...overrides,
});
const options = (workspaces = [workspace(), workspace("second")]) => ({
  workspaces,
  identity: { user_id: "internal-user", display_name: "本人账号" },
  csrf_token: "options-csrf",
  contract_version: "plane.weekly-report.v1",
});
const connection = (id = "11111111-2222-4333-8444-555555555555", overrides = {}) => ({
  id,
  workspace: "public",
  label: "已存周报连接",
  actions: ["save_draft"],
  report_type: "WEEKLY",
  period_policy: "current_and_previous_week.v1",
  created_at: "2026-10-26T00:00:00Z",
  expires_at: "2099-01-01T00:00:00Z",
  revoked_at: null,
  last_used_at: null,
  ...overrides,
});
const page = (results: any[] = [], next_cursor: string | null = null) => ({
  results,
  next_cursor,
  csrf_token: "list-csrf",
});
const secret = `pwr_${"a".repeat(43)}`;
const issued = () => ({
  ...connection(),
  label: "个人周报助手",
  mcp_path: "/api/research/workspaces/public/weekly-report-agent/mcp/",
  headers: { "X-Weekly-Report-Token": secret },
  csrf_token: "issue-csrf",
});
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (value: any) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.resetAllMocks();
  modalStore.profileSettingsModal.isOpen = true;
  workspaceStore.currentWorkspace = { slug: "public" };
  mocks.options.mockResolvedValue(options());
  mocks.connections.mockResolvedValue(page());
  mocks.issue.mockResolvedValue(issued());
  mocks.revoke.mockResolvedValue({ revoked: true });
  mocks.copy.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(element: React.ReactNode = <WeeklyReportMCPSettings workspaceSlug="public" />) {
  await act(async () => root.render(element));
}
const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === label || b.getAttribute("aria-label") === label
  )!;
async function click(label: string) {
  expect(button(label), label).toBeTruthy();
  await act(async () => button(label).click());
}
async function check(label: string) {
  await act(async () => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!.click());
}
async function select(label: string, value: string) {
  const el = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function generate() {
  await check("保存草稿");
  await click("生成周报连接");
}
const json = () => container.querySelector<HTMLTextAreaElement>('[aria-label="周报 JSON 配置"]');

it.each([false, true])("keeps the original default page and accessible keyboard tabs (modal=%s)", async (inModal) => {
  // Query parameters behind a modal never participate in weekly selection.
  window.history.replaceState({}, "", "/?workspace=second&node=private&token=ignored");
  await render(<MCPProfileSettings inModal={inModal} />);
  expect(container.textContent).toContain(`原连接页：${String(inModal)}`);
  expect(mocks.options).not.toHaveBeenCalled();
  const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  await act(async () => tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(document.activeElement).toBe(tabs[1]);
  expect(tabs[1].getAttribute("aria-selected")).toBe("true");
  expect(container.querySelector<HTMLSelectElement>('[aria-label="周报工作区"]')!.value).toBe("public");
  expect(container.querySelector("[data-existing]")).toBeNull();
  expect(document.getElementById(tabs[1].getAttribute("aria-controls")!)?.getAttribute("aria-labelledby")).toBe(
    tabs[1].id
  );
  await act(async () => tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
  expect(document.activeElement).toBe(tabs[0]);
  expect(container.textContent).toContain("原连接页");
  await act(async () => tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(tabs[1].getAttribute("tabindex")).toBe("0");
});

it("uses backend permissions/expiry, session identity, and exact isolated configuration formats", async () => {
  await render();
  expect(button("生成周报连接").disabled).toBe(true);
  expect(container.textContent).toContain("本人账号");
  expect(container.textContent).not.toContain("internal-user");
  expect([...container.querySelectorAll('[aria-label="周报连接有效期"] option')].map((o) => o.textContent)).toEqual([
    "1 天",
    "7 天",
  ]);
  await select("周报连接有效期", "7");
  await generate();
  expect(mocks.issue).toHaveBeenCalledWith(
    "public",
    { label: "个人周报助手", actions: ["save_draft"], ttl_days: 7 },
    "list-csrf"
  );
  const files = JSON.parse(json()!.value);
  const entry = Object.values(files.mcpServers)[0] as any;
  expect(entry).toEqual({
    type: "http",
    url: "https://plane.test/api/research/workspaces/public/weekly-report-agent/mcp/",
    headers: { "X-Weekly-Report-Token": secret },
    timeoutSeconds: 120,
  });
  expect(Object.keys(files.mcpServers)).toEqual(["plane_weekly_report_11111111222243338444555555555555"]);
  await click("复制 JSON");
  expect(mocks.copy).toHaveBeenCalledWith(json()!.value);
  await click("导出 TOML");
  expect(mocks.download).toHaveBeenCalledWith(expect.stringContaining(`"X-Weekly-Report-Token" = "${secret}"`), "toml");
  await click("导出 JSON");
  expect(mocks.download).toHaveBeenLastCalledWith(json()!.value, "json");
  expect(window.location.href).not.toContain(secret);
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  expect(button("生成周报连接").disabled).toBe(true);
  await click("清除周报配置和密钥");
  expect(json()).toBeNull();
  expect(container.innerHTML).not.toContain(secret);
});

it("requires explicit submit permission without implying draft permission", async () => {
  mocks.options.mockResolvedValue(options([workspace("public", { actions: ["submit"], ttl_days: [30] })]));
  await render();
  expect(container.querySelector('[aria-label="保存草稿"]')).toBeNull();
  await check("正式提交");
  await click("生成周报连接");
  expect(mocks.issue.mock.calls[0][1]).toEqual({ label: "个人周报助手", actions: ["submit"], ttl_days: 30 });
});

it("clears secrets on workspace/tab/modal close and reopening never restores them", async () => {
  await render(<MCPProfileSettings inModal />);
  await click("周报连接");
  await generate();
  expect(json()).not.toBeNull();
  await select("周报工作区", "second");
  expect(json()).toBeNull();
  expect(container.innerHTML).not.toContain(secret);
  await select("周报工作区", "public");
  await generate();
  await click("现有连接");
  await click("周报连接");
  expect(json()).toBeNull();
  await generate();
  await act(async () => {
    modalStore.profileSettingsModal.isOpen = false;
  });
  expect(container.innerHTML).not.toContain(secret);
  expect(container.querySelector('[role="tab"]')).toBeNull();
  await act(async () => {
    modalStore.profileSettingsModal.isOpen = true;
  });
  await click("周报连接");
  expect(json()).toBeNull();
});

it("drops late issue/list/options responses from an abandoned workspace or unmounted page", async () => {
  const lateIssue = deferred();
  mocks.issue.mockReturnValueOnce(lateIssue.promise);
  await render();
  await generate();
  await select("周报工作区", "second");
  await act(async () => lateIssue.resolve(issued()));
  expect(json()).toBeNull();
  expect(container.innerHTML).not.toContain(secret);
  const lateList = deferred();
  mocks.connections.mockReturnValueOnce(lateList.promise);
  await select("周报工作区", "public");
  await select("周报工作区", "second");
  await act(async () => lateList.resolve(page([connection()])));
  expect(container.textContent).not.toContain("已存周报连接");
  const lateOptions = deferred();
  mocks.options.mockReturnValueOnce(lateOptions.promise);
  await click("刷新周报能力");
  await render(<p>已离开设置</p>);
  await act(async () => lateOptions.resolve(options()));
  expect(container.textContent).toBe("已离开设置");
});

it("clears credentials on an external workspace switch and discards issuance after modal close", async () => {
  await render(<MCPProfileSettings inModal />);
  await click("周报连接");
  await generate();
  expect(json()).not.toBeNull();
  await act(async () => {
    workspaceStore.currentWorkspace = { slug: "second" };
  });
  expect(json()).toBeNull();
  expect(container.innerHTML).not.toContain(secret);
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("现有连接");
  await act(async () => {
    workspaceStore.currentWorkspace = { slug: "public" };
  });
  await click("周报连接");
  const pending = deferred();
  mocks.issue.mockReturnValueOnce(pending.promise);
  await generate();
  await act(async () => {
    modalStore.profileSettingsModal.isOpen = false;
  });
  await act(async () => pending.resolve(issued()));
  expect(container.innerHTML).not.toContain(secret);
  await act(async () => {
    modalStore.profileSettingsModal.isOpen = true;
  });
  await click("周报连接");
  expect(json()).toBeNull();
});

it("requires a successful list before issuing and renders expiry and last-use metadata", async () => {
  mocks.connections.mockRejectedValueOnce({ message: "列表未加载" });
  await render();
  await check("保存草稿");
  expect(button("生成周报连接").disabled).toBe(true);
  mocks.connections.mockResolvedValue(
    page([connection("expired", { expires_at: "2000-01-01T00:00:00Z", last_used_at: "2026-10-25T00:00:00Z" })])
  );
  await click("重试周报连接列表");
  expect(button("生成周报连接").disabled).toBe(false);
  expect(container.textContent).toContain("已到期");
  expect(container.textContent).toContain("最近使用：");
  expect(container.textContent).not.toContain("尚未使用");
});

it("blocks double clicks synchronously and recovers uncertain issuance by listing without an automatic retry", async () => {
  const pending = deferred();
  mocks.issue.mockReturnValueOnce(pending.promise);
  await render();
  await check("保存草稿");
  const form = container.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(mocks.issue).toHaveBeenCalledTimes(1);
  mocks.connections.mockResolvedValue(page([connection()]));
  await act(async () => pending.reject({ uncertain: true, message: "ignored" }));
  expect(container.textContent).toContain("签发结果尚未确认");
  expect(container.textContent).toContain("已存周报连接");
  expect(mocks.issue).toHaveBeenCalledTimes(1);
  expect(button("生成周报连接").disabled).toBe(true);
  await click("已核对连接，继续创建");
  expect(button("生成周报连接").disabled).toBe(false);
});

it("keeps uncertain creation blocked until a failed recovery list has been refreshed", async () => {
  await render();
  mocks.issue.mockRejectedValue({ uncertain: true });
  mocks.connections.mockRejectedValue({ message: "列表暂不可用" });
  await generate();
  expect(button("已核对连接，继续创建").disabled).toBe(true);
  mocks.connections.mockResolvedValue(page([connection()]));
  await click("重试周报连接列表");
  expect(button("已核对连接，继续创建").disabled).toBe(false);
  expect(mocks.issue).toHaveBeenCalledTimes(1);
});

it("does not retain malformed or cross-workspace credentials and requires recovery", async () => {
  mocks.issue.mockResolvedValue({
    ...issued(),
    mcp_path: "https://evil.test/",
    headers: { "X-Weekly-Report-Token": secret },
  });
  await render();
  await generate();
  expect(json()).toBeNull();
  expect(container.innerHTML).not.toContain(secret);
  expect(container.textContent).toContain("签发结果尚未确认");
});

it("shows feature-disabled workspaces while preserving list/revoke and never offers extra actions", async () => {
  mocks.options.mockResolvedValue(
    options([workspace("public", { enabled: false, actions: [], unavailable_reason: "功能开关关闭" })])
  );
  mocks.connections.mockResolvedValue(page([connection()]));
  await render();
  expect(container.textContent).toContain("功能开关关闭");
  expect(container.textContent).toContain("已存周报连接");
  expect(button("生成周报连接").disabled).toBe(true);
  await click("撤销周报连接：已存周报连接");
  await click("确认撤销");
  expect(mocks.revoke).toHaveBeenCalledWith("public", connection().id, "list-csrf");
});

it("keeps list pages on failure, retries the same cursor, and ignores foreign rows", async () => {
  mocks.connections
    .mockResolvedValueOnce(page([connection("one")], "next"))
    .mockRejectedValueOnce({ message: "下一页失败" })
    .mockResolvedValueOnce(
      page([
        connection("two", { label: "第二页" }),
        connection("foreign", { workspace: "second", label: "别人的工作区" }),
      ])
    );
  await render();
  await click("加载更多周报连接");
  expect(container.textContent).toContain("下一页失败");
  expect(container.textContent).toContain("已存周报连接");
  await click("重试周报连接列表");
  expect(mocks.connections).toHaveBeenLastCalledWith("public", "next");
  expect(container.textContent).toContain("第二页");
  expect(container.textContent).not.toContain("别人的工作区");
});

it("confirms revocation, reports failures, refreshes on success and clears the matching secret", async () => {
  await render();
  mocks.connections.mockResolvedValue(page([connection()]));
  await generate();
  await click("撤销周报连接：已存周报连接");
  await click("取消");
  expect(mocks.revoke).not.toHaveBeenCalled();
  mocks.revoke.mockRejectedValueOnce({ message: "撤销失败" });
  await click("撤销周报连接：已存周报连接");
  await click("确认撤销");
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain("撤销失败");
  expect(json()).toBeNull();
  mocks.connections.mockResolvedValue(page([connection(undefined, { revoked_at: "2026-10-26T00:00:00Z" })]));
  await click("确认撤销");
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain("周报连接已撤销");
  expect(button("撤销周报连接：已存周报连接").disabled).toBe(true);
});

it("shows loading/empty/errors and retries reads; a known issue rejection never auto-retries", async () => {
  const pending = deferred();
  mocks.options.mockReturnValueOnce(pending.promise);
  await render();
  expect(container.textContent).toContain("正在加载周报设置");
  await act(async () => pending.reject({ message: "能力加载失败" }));
  expect(container.textContent).toContain("能力加载失败");
  mocks.options.mockResolvedValueOnce(options([]));
  await click("重试周报设置");
  expect(container.textContent).toContain("暂无可管理");
  await click("刷新周报能力");
  mocks.issue.mockRejectedValueOnce({ uncertain: false, status: 403, message: "当前无权签发" });
  await generate();
  expect(container.textContent).toContain("当前无权签发");
  expect(mocks.issue).toHaveBeenCalledTimes(1);
  expect(button("已核对连接，继续创建")).toBeUndefined();
});

it("survives StrictMode read effect replay and reports clipboard/export failures without leaking errors", async () => {
  await render(
    <StrictMode>
      <WeeklyReportMCPSettings workspaceSlug="public" />
    </StrictMode>
  );
  await generate();
  expect(json()).not.toBeNull();
  mocks.copy.mockRejectedValue(new Error(secret));
  await click("复制 TOML");
  expect(container.textContent).toContain("复制失败");
  mocks.download.mockImplementation(() => {
    throw new Error(secret);
  });
  await click("导出 JSON");
  expect(container.textContent).toContain("导出失败");
  expect(container.querySelector('[role="status"]')?.textContent).not.toContain(secret);
});

it("hydrates existing connections with stable dates and no server-dependent expiry status", async () => {
  const format = vi.spyOn(Date.prototype, "toLocaleString");
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-27T00:00:00Z"));
  const element = (
    <WeeklyReportConnectionsList
      list={{
        rows: [connection(undefined, { expires_at: "2026-10-27T00:00:01Z" })],
        cursor: null,
        busy: false,
        ready: true,
        error: "",
        load: vi.fn(),
        failedCursor: { current: undefined },
      }}
      busy={false}
      onRevoke={vi.fn()}
    />
  );
  const host = document.createElement("div");
  host.innerHTML = renderToString(element);
  expect(host.textContent).toContain("正在核对有效期");
  expect(host.textContent).toContain("UTC+8");
  expect(format).toHaveBeenCalledWith("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  // Expiry crosses between the server render and hydration; the first client render must still match.
  clock.mockReturnValue(Date.parse("2026-10-27T00:00:02Z"));
  document.body.appendChild(host);
  const recoverable = vi.fn();
  let hydrated!: ReturnType<typeof hydrateRoot>;
  try {
    await act(async () => {
      hydrated = hydrateRoot(host, element, { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("正在核对有效期");
    expect(host.textContent).toContain("已到期");
  } finally {
    if (hydrated) await act(async () => hydrated.unmount());
    host.remove();
  }
});

it("updates expiry while the page stays open and stops its timer when leaving", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T00:00:00Z"));
  mocks.connections.mockResolvedValue(page([connection("expiring", { expires_at: "2026-10-27T00:00:01Z" })]));
  await render();
  const row = () => container.querySelector("article")!.textContent;
  expect(row()).toContain("· 有效");
  await act(async () => {
    vi.advanceTimersByTime(30_000);
  });
  expect(row()).toContain("已到期");
  await render(<p>已离开设置</p>);
  expect(vi.getTimerCount()).toBe(0);
});

it("uses the new workspace's expiry choices after a custom expiry was selected", async () => {
  mocks.options.mockResolvedValue(options([workspace(), workspace("second", { ttl_days: [30] })]));
  await render();
  await select("周报连接有效期", "7");
  await select("周报工作区", "second");
  expect(container.querySelector<HTMLSelectElement>('[aria-label="周报连接有效期"]')!.value).toBe("30");
  await generate();
  expect(mocks.issue).toHaveBeenCalledWith(
    "second",
    { label: "个人周报助手", actions: ["save_draft"], ttl_days: 30 },
    "list-csrf"
  );
});

it.each(["issue", "revoke"])("releases %s busy state when its follow-up list refresh fails", async (operation) => {
  mocks.connections.mockResolvedValue(page([connection()]));
  await render();
  mocks.connections.mockRejectedValueOnce({ message: "刷新暂不可用" });
  if (operation === "issue") {
    await generate();
    expect(json()).not.toBeNull();
    expect(container.textContent).not.toContain("签发结果尚未确认");
  } else {
    await click("撤销周报连接：已存周报连接");
    await click("确认撤销");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain("周报连接已撤销");
    await check("保存草稿");
  }
  expect(container.textContent).toContain("刷新暂不可用");
  expect(button("重试周报连接列表").disabled).toBe(false);
  await click("重试周报连接列表");
  if (operation === "issue") await click("清除周报配置和密钥");
  expect(button("生成周报连接").disabled).toBe(false);
});
