// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  list: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/services/notification-policy.service", () => ({
  WorkspaceNotificationPolicyService: class {
    list = service.list;
    update = service.update;
  },
}));

const { WorkspaceNotificationSettings } = await import("@/components/workspace/workspace-notification-settings");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  await act(async () => root.render(<WorkspaceNotificationSettings workspaceSlug="public" />));
}

beforeEach(() => {
  service.list.mockResolvedValue({
    policies: [
      { category: "property_change", in_app_enabled: true, email_enabled: true },
      { category: "system_announcement", in_app_enabled: true, email_enabled: true },
    ],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("renders grouped workspace notification policies", async () => {
  await render();

  expect(service.list).toHaveBeenCalledWith("public");
  expect(container.textContent).toContain("任务通知");
  expect(container.textContent).toContain("科研通知");
  expect(container.textContent).toContain("系统公告");
  expect(container.textContent).toContain("邮件不适用");
});

it("saves one channel toggle and refreshes the server state", async () => {
  service.update.mockResolvedValue({
    policies: [{ category: "property_change", in_app_enabled: true, email_enabled: false }],
  });

  await render();
  await act(async () => {
    container.querySelector<HTMLInputElement>('input[name="property_change-email"]')?.click();
  });

  expect(service.update).toHaveBeenCalledWith("public", [{ category: "property_change", email_enabled: false }]);
  expect(container.querySelector<HTMLInputElement>('input[name="property_change-email"]')?.checked).toBe(false);
});

it("keeps server state visible when saving fails", async () => {
  service.update.mockRejectedValue(new Error("failed"));

  await render();
  await act(async () => {
    container.querySelector<HTMLInputElement>('input[name="system_announcement-in-app"]')?.click();
  });

  expect(container.querySelector('[role="alert"]')?.textContent).toContain("通知策略保存失败");
  expect(container.querySelector<HTMLInputElement>('input[name="system_announcement-in-app"]')?.checked).toBe(true);
});
