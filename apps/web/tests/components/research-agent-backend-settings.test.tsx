// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const service = vi.hoisted(() => ({
  getBackendConnection: vi.fn(),
  saveBackendConnection: vi.fn(),
  testBackendConnection: vi.fn(),
  deleteBackendConnection: vi.fn(),
}));
const translate = (key: string, values?: Record<string, string>) => {
  const value = key.split(".").reduce<unknown>((obj, part) => (obj as Record<string, unknown>)?.[part], translations);
  return Object.entries(values ?? {}).reduce(
    (text, [name, replacement]) => text.replace(`{${name}}`, replacement),
    String(value ?? key)
  );
};
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, string>) => translate(key, values) }),
}));
vi.mock("@/services/research/agent.service", () => ({
  ResearchAgentService: class {
    getBackendConnection = service.getBackendConnection;
    saveBackendConnection = service.saveBackendConnection;
    testBackendConnection = service.testBackendConnection;
    deleteBackendConnection = service.deleteBackendConnection;
  },
}));
const { AgentBackendSettings } = await import("@/components/research/settings/system/agent-backend-settings");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
const connection = {
  id: "one",
  base_url: "http://172.19.0.1:14310",
  is_enabled: true,
  has_credential: true,
  health_status: "OK",
  last_error: "",
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  service.getBackendConnection.mockResolvedValue({ connection, governance_enabled: true });
  service.saveBackendConnection.mockResolvedValue({ id: "one" });
  service.testBackendConnection.mockResolvedValue({ ok: true, models: 1 });
  service.deleteBackendConnection.mockResolvedValue(true);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
/** 在指定工作区渲染真实连接表单。 */
async function renderForm(slug = "public") {
  await act(async () => root.render(<AgentBackendSettings workspaceSlug={slug} workspaceName={slug} />));
}
/** 通过 DOM 输入事件修改表单，模拟真实编辑。 */
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
/** 返回指定操作按钮。 */
function button(label: string) {
  return Array.from(container.querySelectorAll("button")).find((item) => item.textContent === label)!;
}
it("saves without replacing a blank stored token and keeps testing available after refresh", async () => {
  await renderForm();
  expect((container.querySelector('input[type="password"]') as HTMLInputElement).value).toBe("");
  await act(async () => button("保存连接").click());
  expect(service.saveBackendConnection).toHaveBeenCalledWith("public", {
    base_url: connection.base_url,
    is_enabled: true,
  });
  expect(button("测试连接").disabled).toBe(false);
  await act(async () => button("测试连接").click());
  expect(container.textContent).toContain("连接成功，可用模型档案 1 个");
  expect(button("测试连接").disabled).toBe(false);
});
it("permits saving and testing while the workspace governance switch is off", async () => {
  service.getBackendConnection.mockResolvedValue({ connection, governance_enabled: false });
  await renderForm();
  expect(container.textContent).toContain("配置暂不用于新会话");
  expect(button("保存连接").disabled).toBe(false);
  expect(button("测试连接").disabled).toBe(false);
});
it("clears the password and shows the replacement connection after saving", async () => {
  await renderForm();
  await fill(container.querySelector('input[type="password"]')!, "fresh-token");
  await act(async () => button("保存连接").click());
  expect(service.saveBackendConnection).toHaveBeenCalledWith(
    "public",
    expect.objectContaining({ token: "fresh-token" })
  );
  expect((container.querySelector('input[type="password"]') as HTMLInputElement).value).toBe("");
});
it("removes the connection and allows a new connection to be saved", async () => {
  await renderForm();
  service.getBackendConnection.mockResolvedValue({ connection: null, governance_enabled: true });
  await act(async () => button("删除").click());
  expect(service.deleteBackendConnection).toHaveBeenCalledWith("public");
  expect(container.textContent).toContain("连接已删除");
  const baseUrlInput = container.querySelector("input:not([type])") as HTMLInputElement;
  expect(baseUrlInput.value).toBe("");
  await fill(baseUrlInput, "http://172.19.0.1:14310");
  expect(button("保存连接").disabled).toBe(false);
});
it("discards a late save from the previous workspace and clears its unsaved token", async () => {
  let finishSave!: (value: { id: string }) => void;
  service.saveBackendConnection.mockReturnValue(
    new Promise((resolve) => {
      finishSave = resolve;
    })
  );
  await renderForm();
  await fill(container.querySelector('input[type="password"]')!, "previous-workspace-token");
  await act(async () => button("保存连接").click());
  service.getBackendConnection.mockResolvedValue({ connection: null, governance_enabled: false });
  await renderForm("private");
  await act(async () => finishSave({ id: "old" }));
  expect(container.textContent).not.toContain("连接已保存");
  expect((container.querySelector('input[type="password"]') as HTMLInputElement).value).toBe("");
  expect(service.getBackendConnection.mock.calls.at(-1)).toEqual(["private"]);
});
it("discards a late load from the previous workspace", async () => {
  let finishLoad!: (value: { connection: typeof connection; governance_enabled: boolean }) => void;
  service.getBackendConnection.mockReturnValueOnce(
    new Promise((resolve) => {
      finishLoad = resolve;
    })
  );
  await renderForm();
  service.getBackendConnection.mockResolvedValue({ connection: null, governance_enabled: false });
  await renderForm("private");
  await act(async () => finishLoad({ connection, governance_enabled: true }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(service.getBackendConnection.mock.calls).toEqual([["public"], ["private"]]);
  expect((container.querySelector("input:not([type])") as HTMLInputElement).value).toBe("");
  expect(container.textContent).toContain("配置暂不用于新会话");
});
it("shows test failure and releases the operation buttons", async () => {
  await renderForm();
  service.testBackendConnection.mockRejectedValue({ error: "backend unavailable" });
  await act(async () => button("测试连接").click());
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(button("测试连接").disabled).toBe(false);
});
it("loads the connection once on first render and does not reload after local edits", async () => {
  await renderForm();
  expect(service.getBackendConnection).toHaveBeenCalledTimes(1);
  await fill(container.querySelector("input:not([type])")!, "http://172.19.0.1:14311");
  await act(async () => {
    (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(service.getBackendConnection).toHaveBeenCalledTimes(1);
  expect(service.getBackendConnection).toHaveBeenCalledWith("public");
});
it("reloads once after save, test, and delete without starting a load loop", async () => {
  await renderForm();
  expect(service.getBackendConnection).toHaveBeenCalledTimes(1);
  await act(async () => button("保存连接").click());
  expect(service.getBackendConnection).toHaveBeenCalledTimes(2);
  await act(async () => button("测试连接").click());
  expect(service.getBackendConnection).toHaveBeenCalledTimes(3);
  service.getBackendConnection.mockResolvedValue({ connection: null, governance_enabled: true });
  await act(async () => button("删除").click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(service.getBackendConnection).toHaveBeenCalledTimes(4);
  expect(service.saveBackendConnection).toHaveBeenCalledTimes(1);
  expect(service.testBackendConnection).toHaveBeenCalledTimes(1);
  expect(service.deleteBackendConnection).toHaveBeenCalledTimes(1);
});

it("uses the loopback placeholder and shows a forwarder hint only for 127.0.0.1", async () => {
  service.getBackendConnection.mockResolvedValue({ connection: null, governance_enabled: true });
  await renderForm();
  const baseUrlInput = container.querySelector("input:not([type])") as HTMLInputElement;
  expect(baseUrlInput.placeholder).toBe("http://127.0.0.1:4310/");
  expect(container.textContent).toContain("本机 ScienceDiscovery 请填 http://127.0.0.1:4310/");
  expect(container.textContent).not.toContain("将通过本机转发访问此实例");

  await fill(baseUrlInput, "http://127.0.0.1:4310/");
  expect(container.textContent).toContain("将通过本机转发访问此实例，无需改成其他地址。");
  expect(container.textContent).not.toContain("172.19");
  expect(container.textContent).not.toContain("14310");

  await fill(baseUrlInput, "http://172.19.0.1:14310");
  expect(container.textContent).not.toContain("将通过本机转发访问此实例");
});
it("saves and redisplays the entered 127.0.0.1 address without rewriting the form", async () => {
  service.getBackendConnection.mockResolvedValue({ connection: null, governance_enabled: true });
  await renderForm();
  await fill(container.querySelector("input:not([type])") as HTMLInputElement, "http://127.0.0.1:4310/");
  await fill(container.querySelector('input[type="password"]')!, "sd-token");
  service.getBackendConnection.mockResolvedValue({
    connection: { ...connection, base_url: "http://127.0.0.1:4310" },
    governance_enabled: true,
  });
  await act(async () => button("保存连接").click());
  expect(service.saveBackendConnection).toHaveBeenCalledWith("public", {
    base_url: "http://127.0.0.1:4310/",
    token: "sd-token",
    is_enabled: true,
  });
  expect((container.querySelector("input:not([type])") as HTMLInputElement).value).toBe("http://127.0.0.1:4310");
  expect(container.textContent).toContain("将通过本机转发访问此实例");
});
it("does not show the forwarder hint for a saved private LAN address", async () => {
  await renderForm();
  expect((container.querySelector("input:not([type])") as HTMLInputElement).value).toBe("http://172.19.0.1:14310");
  expect(container.textContent).toContain("本机 ScienceDiscovery 请填 http://127.0.0.1:4310/");
  expect(container.textContent).not.toContain("将通过本机转发访问此实例");
});

it("keeps the form visible while a save refresh is in flight", async () => {
  await renderForm();
  let finishRefresh!: (value: unknown) => void;
  service.getBackendConnection.mockReturnValueOnce(
    new Promise((resolve) => {
      finishRefresh = resolve;
    })
  );
  await act(async () => button("保存连接").click());
  expect(container.querySelector("input:not([type])")).not.toBeNull();
  expect(container.textContent).toContain("处理中");
  expect(container.textContent).toContain("测试连接");
  expect(container.textContent).not.toBe("加载中");
  await act(async () => finishRefresh({ connection, governance_enabled: true }));
});
