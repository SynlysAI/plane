// @vitest-environment jsdom
import React, { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observable, runInAction } from "mobx";

const mocks = vi.hoisted(() => ({
  options: vi.fn(),
  connections: vi.fn(),
  issue: vi.fn(),
  configuration: vi.fn(),
  rotate: vi.fn(),
  revoke: vi.fn(),
  copy: vi.fn(),
  download: vi.fn(),
}));
vi.mock("@plane/constants", () => ({ API_BASE_URL: "https://plane.test" }));
vi.mock("@plane/propel/button", () => ({
  Button: ({ children, variant: _variant, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock("@plane/ui", () => ({
  EModalPosition: { CENTER: "center" },
  EModalWidth: { XXL: "xxl" },
  ModalCore: ({ isOpen, children }: any) => (isOpen ? <div role="dialog">{children}</div> : null),
  AlertModalCore: ({ isOpen, title, content, handleSubmit, handleClose, isSubmitting, primaryButtonText }: any) =>
    isOpen ? (
      <div role="dialog">
        <h2>{title}</h2>
        {content}
        <button disabled={isSubmitting} onClick={handleSubmit}>
          {primaryButtonText.default}
        </button>
        <button disabled={isSubmitting} onClick={handleClose}>
          取消
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
vi.mock("@/services/unified-mcp.service", () => ({
  UnifiedMCPService: class {
    options = mocks.options;
    connections = mocks.connections;
    issue = mocks.issue;
    configuration = mocks.configuration;
    rotate = mocks.rotate;
    revoke = mocks.revoke;
  },
}));
vi.mock("@/services/weekly-report-mcp.service", () => ({
  WeeklyReportMCPService: class {
    options = mocks.options;
    connections = mocks.connections;
    issue = mocks.issue;
    configuration = mocks.configuration;
    rotate = mocks.rotate;
    revoke = mocks.revoke;
  },
}));
const user = observable({ id: "user-one" });
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: user }) }));
vi.mock("@/hooks/store/use-workspace", () => ({ useWorkspace: () => ({ currentWorkspace: { slug: "lab" } }) }));
vi.mock("@/hooks/store/use-command-palette", () => ({
  useCommandPalette: () => ({ profileSettingsModal: { isOpen: true } }),
}));
vi.mock("react-router", () => ({ useSearchParams: () => [new URLSearchParams()] }));
import { UnifiedMCPManager } from "@/components/mcp/unified-mcp-manager";
import { WeeklyReportMCPSettings } from "@/components/mcp/weekly-report-settings";
import { MCPProfileSettings } from "@/components/settings/profile/content/pages/mcp";
import { unifiedMetadata } from "@/components/mcp/unified-config";
import { weeklyReportMetadata } from "@/components/mcp/weekly-report-config";

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const ID = "11111111-2222-4333-8444-555555555555";
const SECOND_ID = "21111111-2222-4333-8444-555555555555";
const LIFETIMES = [1, 7, 30, 365, null];
const common = {
  id: ID,
  created_at: "2026-10-30T00:00:00Z",
  expires_at: null,
  revoked_at: null,
  last_used_at: null,
  configuration_available: true,
};
const projectSecret = "pum_" + "a".repeat(43);
const weeklySecret = "pwr_" + "b".repeat(43);
const project = {
  ...common,
  name: "我的连接",
  scope: {
    include_future_objects: true,
    workspaces: [
      { workspace_id: "lab-id", workspace_name: "研究工作区", domains: { administrative: "read", research: "read" } },
    ],
  },
  implemented_capabilities: ["read"],
  secret: projectSecret,
  mcp_url: "https://plane.test/api/mcp/",
  codex_toml: "unused",
  sciencediscovery_json: JSON.stringify({
    mcpServers: {
      plane: {
        type: "http",
        url: "https://plane.test/api/mcp/",
        headers: { Authorization: "Bearer " + projectSecret },
      },
    },
  }),
};
const weekly = {
  ...common,
  label: "我的连接",
  workspace: "lab",
  actions: ["save_draft"],
  report_type: "WEEKLY",
  period_policy: "current_and_previous_week.v1",
  mcp_path: "/api/research/workspaces/lab/weekly-report-agent/mcp/",
  headers: { "X-Weekly-Report-Token": weeklySecret },
  csrf_token: "csrf",
};
const page = (results: any[] = [], next_cursor: string | null = null) => ({ results, next_cursor, csrf_token: "csrf" });
const projectOptions = {
  ...page([
    {
      id: "lab-id",
      name: "研究工作区",
      slug: "lab",
      domains: { administrative: ["read", "read_write"], research: ["read", "read_write"] },
    },
  ]),
  max_workspaces: 20,
  ttl_days: LIFETIMES,
  default_ttl_days: 365,
  write_requires_future_objects: true,
};
const weeklyOptions = {
  identity: { display_name: "本人", user_id: "user-one" },
  workspaces: [
    {
      id: "lab-id",
      slug: "lab",
      name: "研究工作区",
      enabled: true,
      actions: ["save_draft", "submit"],
      ttl_days: LIFETIMES,
      default_ttl_days: 365,
      period_description: "仅本人本周与上周的周报。",
    },
  ],
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.resetAllMocks();
  runInAction(() => {
    user.id = "user-one";
  });
  mocks.connections.mockResolvedValue(page());
  mocks.revoke.mockResolvedValue({ revoked: true });
  mocks.copy.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
/** 渲染真实业务组件，网络与共享弹窗框架隔离。 */
async function render(node: React.ReactNode) {
  await act(async () => root.render(node));
}
/** 按可访问名称触发按钮。 */
async function click(label: string) {
  const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.textContent === label || el.getAttribute("aria-label") === label
  );
  expect(element, label).toBeTruthy();
  await act(async () => element!.click());
}
/** 输入原生控件值并触发 React 事件。 */
async function inputName(name: string) {
  const el = container.querySelector<HTMLInputElement>('[aria-label="连接名称"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, name);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
/** 改变下拉选择。 */
async function select(label: string, value: string) {
  const el = container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
/** 创建可手动完成的请求，用于验证迟到响应。 */
function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}
const text = () => container.querySelector<HTMLTextAreaElement>("textarea")?.value;

describe.each(["project", "weekly"] as const)("%s 连接的公共行为", (kind) => {
  const isWeekly = kind === "weekly";
  const value = isWeekly ? weekly : project;
  const secret = isWeekly ? weeklySecret : projectSecret;
  const element = () =>
    isWeekly ? <WeeklyReportMCPSettings workspaceSlug="lab" /> : <UnifiedMCPManager initialWorkspace="lab" />;
  const metadata = (item: any = value) => (isWeekly ? weeklyReportMetadata(item) : unifiedMetadata(item));
  beforeEach(() => {
    mocks.options.mockResolvedValue(isWeekly ? weeklyOptions : projectOptions);
    mocks.issue.mockResolvedValue(value);
    mocks.configuration.mockResolvedValue(value);
    mocks.rotate.mockResolvedValue(value);
  });
  /** 勾选必要授权并打开命名弹窗。 */
  async function openCreate() {
    if (isWeekly) await act(async () => container.querySelector<HTMLInputElement>('[aria-label="保存草稿"]')!.click());
    await click("创建连接");
  }
  it("确认前零创建、取消零创建，名称只在弹窗内出现", async () => {
    await render(element());
    expect(container.querySelector('[aria-label="连接名称"]')).toBeNull();
    expect(container.querySelector<HTMLSelectElement>('[aria-label="连接有效期"]')!.value).toBe("365");
    await openCreate();
    expect(mocks.issue).not.toHaveBeenCalled();
    await click("取消");
    expect(mocks.issue).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="连接名称"]')).toBeNull();
  });
  it("显式命名后只创建一次并自动展示新连接，永不过期保持 null", async () => {
    await render(element());
    await select("连接有效期", "never");
    await openCreate();
    await inputName("我的连接");
    const pending = deferred();
    mocks.issue.mockReturnValueOnce(pending.promise);
    await click("确认生成");
    await click("正在创建…");
    expect(mocks.issue).toHaveBeenCalledTimes(1);
    const request = mocks.issue.mock.calls[0][isWeekly ? 1 : 0];
    expect(request.ttl_days).toBeNull();
    expect(request[isWeekly ? "label" : "name"]).toBe("我的连接");
    expect(request.actions ?? request.workspaces).toBeTruthy();
    await act(async () => pending.resolve(value));
    expect(text()).toContain(secret);
    expect(container.querySelector('[aria-label="连接详情 我的连接"]')).toBeTruthy();
    expect(container.textContent).toContain("永不过期");
    expect(JSON.stringify(metadata())).not.toContain(secret);
  });
  it("拒绝空白名称和控制字符", async () => {
    await render(element());
    await openCreate();
    await inputName("   ");
    await click("确认生成");
    expect(mocks.issue).not.toHaveBeenCalled();
    await inputName("abc\u007f");
    await click("确认生成");
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it("刷新后按需回看原配置，隐藏后清除密钥并支持复制导出", async () => {
    mocks.connections.mockResolvedValue(page([metadata()]));
    const storage = vi.spyOn(Storage.prototype, "setItem");
    await render(element());
    expect(text()).toBeUndefined();
    await click("查看连接 我的连接");
    expect(mocks.configuration).not.toHaveBeenCalled();
    await click("查看配置");
    expect(text()).toContain(secret);
    await click("通用 MCP JSON");
    expect(Object.keys(JSON.parse(text()!).mcpServers)).toHaveLength(1);
    await click("复制配置");
    expect(mocks.copy).toHaveBeenCalledWith(text());
    await click("导出配置");
    expect(mocks.download).toHaveBeenCalledWith(text(), "json");
    await click("隐藏配置");
    expect(text()).toBeUndefined();
    expect(storage).not.toHaveBeenCalled();
  });
  it("旧连接需确认重置，失败保留详情，成功后可回看", async () => {
    mocks.connections.mockResolvedValue(page([{ ...metadata(), configuration_available: false }]));
    await render(element());
    await click("查看连接 我的连接");
    expect(container.textContent).toContain("尚未保存可恢复密钥");
    await click("重置密钥");
    expect(mocks.rotate).not.toHaveBeenCalled();
    mocks.rotate.mockRejectedValueOnce({ status: 400 });
    await click("确认重置");
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    await click("确认重置");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(text()).toContain(secret);
  });
  it("撤销成功前保留原状态，成功后清除配置并禁止回看", async () => {
    mocks.connections.mockResolvedValue(page([metadata()]));
    await render(element());
    await click("查看连接 我的连接");
    await click("查看配置");
    await click("撤销连接");
    expect(mocks.revoke).not.toHaveBeenCalled();
    mocks.revoke.mockRejectedValueOnce({ status: 503 });
    await click("确认撤销");
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    await click("确认撤销");
    expect(text()).toBeUndefined();
    expect(container.textContent).toContain("已撤销");
  });
  it("切换详情忽略迟到配置，返回列表后也不发布旧响应", async () => {
    const second = { ...metadata(), id: SECOND_ID, name: "另一条", label: "另一条" };
    mocks.connections.mockResolvedValue(page([metadata(), second]));
    const pending = deferred();
    mocks.configuration.mockReturnValueOnce(pending.promise);
    await render(element());
    await click("查看连接 我的连接");
    await click("查看配置");
    await click("查看连接 另一条");
    await act(async () => pending.resolve(value));
    expect(text()).toBeUndefined();
    expect(container.querySelector('[aria-label="连接详情 另一条"]')).toBeTruthy();
  });
  it("隐藏加载中的配置，阻止迟到响应重新显示", async () => {
    mocks.connections.mockResolvedValue(page([metadata()]));
    const pending = deferred();
    mocks.configuration.mockReturnValueOnce(pending.promise);
    await render(element());
    await click("查看连接 我的连接");
    await click("查看配置");
    await click("隐藏配置");
    await act(async () => pending.resolve(value));
    expect(text()).toBeUndefined();
  });
  it("重置超时后刷新列表并通过回看核对密钥", async () => {
    mocks.connections.mockResolvedValue(page([metadata()]));
    mocks.rotate.mockRejectedValueOnce({ status: 503 });
    await render(element());
    await click("查看连接 我的连接");
    await click("重置密钥");
    await click("确认重置");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain("重置结果尚未确认");
    await click("查看配置");
    expect(text()).toContain(secret);
    expect(mocks.rotate).toHaveBeenCalledTimes(1);
  });
  it("页面跨过到期时间后清除已显示的密钥", async () => {
    mocks.connections.mockResolvedValue(
      page([{ ...metadata(), expires_at: new Date(Date.now() + 2000).toISOString() }])
    );
    vi.useFakeTimers();
    try {
      await render(element());
      await click("查看连接 我的连接");
      await click("查看配置");
      expect(text()).toContain(secret);
      await act(async () => {
        vi.setSystemTime(Date.now() + 3000);
        await vi.advanceTimersByTimeAsync(2500);
      });
      expect(text()).toBeUndefined();
      expect(container.textContent).toContain("已过期");
    } finally {
      vi.useRealTimers();
    }
  });
  it("离开页面后清除密钥，并忽略加载中的配置响应", async () => {
    mocks.connections.mockResolvedValue(page([metadata()]));
    await render(element());
    await click("查看连接 我的连接");
    await click("查看配置");
    expect(text()).toContain(secret);
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(text()).toBeUndefined();
    const pending = deferred();
    mocks.configuration.mockReturnValueOnce(pending.promise);
    await click("查看配置");
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    await act(async () => pending.resolve(value));
    expect(text()).toBeUndefined();
  });
  it("分页失败保留已有记录并使用原游标重试", async () => {
    mocks.connections.mockResolvedValueOnce(page([metadata()], "next"));
    await render(element());
    mocks.connections.mockRejectedValueOnce({ status: 503 });
    await click("加载更多连接");
    expect(container.textContent).toContain("我的连接");
    mocks.connections.mockResolvedValueOnce(page([{ ...metadata(), id: SECOND_ID, name: "第二条", label: "第二条" }]));
    await click("重试连接列表");
    expect(mocks.connections.mock.calls.at(-1)).toContain("next");
    expect(container.textContent).toContain("第二条");
  });
  it("创建结果不确定时刷新列表，通过回看恢复配置而不重复创建", async () => {
    await render(element());
    await openCreate();
    await inputName("我的连接");
    mocks.issue.mockRejectedValueOnce({ status: 503 });
    mocks.connections.mockResolvedValueOnce(page([metadata()]));
    await click("确认生成");
    expect(mocks.issue).toHaveBeenCalledTimes(1);
    await click("取消");
    await click("查看连接 我的连接");
    await click("查看配置");
    expect(text()).toContain(secret);
    expect(mocks.issue).toHaveBeenCalledTimes(1);
  });
  it("已过期连接保留详情，禁止配置回看与密钥重置", async () => {
    mocks.connections.mockResolvedValue(page([{ ...metadata(), expires_at: "2000-01-01T00:00:00Z" }]));
    await render(element());
    await click("查看连接 我的连接");
    expect(container.textContent).toContain("已过期");
    await click("重置密钥");
    expect(mocks.rotate).not.toHaveBeenCalled();
    expect(text()).toBeUndefined();
  });
  it("StrictMode 重放后仍可加载、创建并清理凭据", async () => {
    await render(<StrictMode>{element()}</StrictMode>);
    await openCreate();
    await inputName("我的连接");
    await click("确认生成");
    expect(text()).toContain(secret);
    await render(<p>离开</p>);
    expect(text()).toBeUndefined();
  });
});

it("项目连接只读默认值、分页工作区与动态写权限约束", async () => {
  mocks.options.mockResolvedValueOnce({ ...projectOptions, next_cursor: "workspaces-next" });
  await render(<UnifiedMCPManager initialWorkspace="lab" />);
  expect(container.querySelector<HTMLSelectElement>('[aria-label="科研任务访问权限 研究工作区"]')!.value).toBe("read");
  await act(async () => container.querySelector<HTMLInputElement>('[aria-label="自动包含新增内容"]')!.click());
  await select("行政项目访问权限 研究工作区", "read_write");
  await click("创建连接");
  expect(mocks.issue).not.toHaveBeenCalled();
  expect(container.textContent).toContain("读写连接需要");
  mocks.options.mockResolvedValueOnce({
    ...projectOptions,
    results: [{ id: "two", slug: "two", name: "第二工作区", domains: { administrative: ["read"] } }],
  });
  await click("加载更多工作区");
  expect(mocks.options).toHaveBeenLastCalledWith("workspaces-next");
  expect(container.textContent).toContain("第二工作区");
});

it("项目连接使用服务端返回的默认有效期", async () => {
  mocks.options.mockResolvedValue({ ...projectOptions, default_ttl_days: 30 });
  await render(<UnifiedMCPManager initialWorkspace="lab" />);
  expect(container.querySelector<HTMLSelectElement>('[aria-label="连接有效期"]')!.value).toBe("30");
  await click("创建连接");
  await inputName("默认有效期连接");
  await click("确认生成");
  expect(mocks.issue).toHaveBeenCalledTimes(1);
  expect(mocks.issue.mock.calls[0][0].ttl_days).toBe(30);
});

it("周报功能关闭仍能显示和撤销已有连接", async () => {
  mocks.options.mockResolvedValue({
    ...weeklyOptions,
    workspaces: [
      { ...weeklyOptions.workspaces[0], enabled: false, actions: [], unavailable_reason: "周报连接尚未开放。" },
    ],
  });
  mocks.connections.mockResolvedValue(page([weeklyReportMetadata(weekly as any)]));
  await render(<WeeklyReportMCPSettings workspaceSlug="lab" />);
  await click("创建连接");
  expect(mocks.issue).not.toHaveBeenCalled();
  await click("查看连接 我的连接");
  await click("撤销连接");
  await click("确认撤销");
  expect(mocks.revoke).toHaveBeenCalledTimes(1);
});
it("页签与账号切换清除项目凭据，保留可访问的键盘导航", async () => {
  mocks.options.mockResolvedValue(projectOptions);
  mocks.issue.mockResolvedValue(project);
  await render(<MCPProfileSettings />);
  await click("创建连接");
  await inputName("我的连接");
  await click("确认生成");
  expect(text()).toContain(projectSecret);
  mocks.options.mockResolvedValue(weeklyOptions);
  const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  await act(async () => tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(document.activeElement).toBe(tabs[1]);
  expect(text()).toBeUndefined();
  mocks.options.mockResolvedValue(projectOptions);
  await act(async () =>
    runInAction(() => {
      user.id = "user-two";
    })
  );
  expect(text()).toBeUndefined();
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("项目连接");
});
