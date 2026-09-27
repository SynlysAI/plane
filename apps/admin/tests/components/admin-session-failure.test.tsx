// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = {
  isUserLoggedIn: undefined as boolean | undefined,
  sessionFailure: undefined as { path: string; status: number | null } | undefined,
  replace: vi.fn(),
};

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: session.replace }) }));
vi.mock("react-router", () => ({ Outlet: () => <div>控制台</div> }));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("@/hooks/store", () => ({
  useUser: () => ({ isUserLoggedIn: session.isUserLoggedIn, sessionFailure: session.sessionFailure }),
}));
vi.mock("@/components/common/header", () => ({ AdminHeader: () => null }));
vi.mock("@/components/common/new-user-popup", () => ({ NewUserPopup: () => null }));
vi.mock("../../app/(all)/(dashboard)/sidebar", () => ({ AdminSidebar: () => null }));
vi.mock("@/app/assets/instance/instance-failure.svg?url", () => ({ default: "failure.svg" }));
vi.mock("@/app/assets/instance/instance-failure-dark.svg?url", () => ({ default: "failure-dark.svg" }));
vi.mock("@/app/(all)/(home)/auth-header", () => ({ AuthHeader: () => null }));
vi.mock("@makeplane/propel/components/button", () => ({
  Button: ({ label, onClick }: { label: string; onClick?: () => void }) => <button onClick={onClick}>{label}</button>,
}));

import AdminLayout from "../../app/(all)/(dashboard)/layout";

describe("admin session failure", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    session.isUserLoggedIn = undefined;
    session.sessionFailure = undefined;
    session.replace.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows the failure path and status instead of the logo", async () => {
    session.sessionFailure = { path: "/api/instances/admins/me/", status: 502 };
    const props = {} as React.ComponentProps<typeof AdminLayout>;
    await act(async () => root.render(<AdminLayout {...props} />));
    expect(container.querySelector("[data-testid='admin-logo-spinner']")).toBeNull();
    expect(container.textContent).toContain("请求路径 /api/instances/admins/me/");
    expect(container.textContent).toContain("状态码 502");
    expect(container.textContent).not.toContain("控制台");
  });

  it("keeps the logo only while the session check is unresolved", async () => {
    const props = {} as React.ComponentProps<typeof AdminLayout>;
    await act(async () => root.render(<AdminLayout {...props} />));
    expect(container.querySelector("[data-testid='admin-logo-spinner']")).not.toBeNull();
  });
});
