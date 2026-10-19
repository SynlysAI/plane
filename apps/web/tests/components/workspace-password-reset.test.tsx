// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ reset: vi.fn(), csrf: vi.fn(), close: vi.fn() }));
vi.mock("@/services/workspace.service", () => ({
  WorkspaceService: class {
    resetMemberPassword = mocks.reset;
  },
}));
vi.mock("@/services/auth.service", () => ({
  AuthService: class {
    requestCSRFToken = mocks.csrf;
  },
}));
vi.mock("@plane/ui", () => ({
  ModalCore: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  EModalPosition: { CENTER: "center" },
  EModalWidth: { XXL: "xxl" },
}));
vi.mock("@plane/propel/button", () => ({
  Button: ({
    children,
    loading: _loading,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) => <button {...props}>{children}</button>,
}));
import { WorkspacePasswordResetModal } from "@/components/workspace/settings/password-reset-modal";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.reset.mockResolvedValue({ temporary_password: "one-time-credential" });
  mocks.csrf.mockResolvedValue({ csrf_token: "csrf" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <WorkspacePasswordResetModal
        workspaceSlug="lab"
        user={{ id: "member", email: "member@example.com", display_name: "成员" }}
        onClose={mocks.close}
      />
    )
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** 完成管理员身份核验和密码填写，触发真实表单提交。 */
async function submitReset() {
  await act(async () => {
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    const password = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(password, "admin-password");
    password.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
}

it("requires verification and sends a password reset only after administrator confirmation", async () => {
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  expect(mocks.reset).not.toHaveBeenCalled();
  await submitReset();
  expect(mocks.reset).toHaveBeenCalledWith("lab", "member", "admin-password", "csrf");
  expect(container.querySelector<HTMLInputElement>("input[readonly]")?.value).toBe("one-time-credential");
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(container.textContent).toContain("下次登录必须修改密码");
  expect(container.querySelector('button[type="submit"]')).toBeNull();
});

it("shows server errors without exposing a temporary password and allows retrying", async () => {
  mocks.reset.mockRejectedValue({ error: "管理员当前密码不正确。" });
  await submitReset();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("管理员当前密码不正确。");
  expect(container.querySelector("input[readonly]")).toBeNull();
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
});

it("clears the generated credential when the dialog is unmounted and reopened", async () => {
  await submitReset();
  await act(async () => root.render(null));
  await act(async () =>
    root.render(
      <WorkspacePasswordResetModal
        workspaceSlug="lab"
        user={{ id: "member", email: "member@example.com", display_name: "成员" }}
        onClose={mocks.close}
      />
    )
  );
  expect(container.querySelector("input[readonly]")).toBeNull();
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("");
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
});
