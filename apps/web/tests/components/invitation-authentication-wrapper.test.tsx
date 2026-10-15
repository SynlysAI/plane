// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: { id: "new-user" } as { id: string } | null,
  params: new URLSearchParams(),
  push: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/navigation", () => ({ useSearchParams: () => state.params, usePathname: () => "/" }));
vi.mock("swr", () => ({ default: () => ({ isLoading: false }) }));
vi.mock("@/helpers/authentication.helper", () => ({
  EPageTypes: { NON_AUTHENTICATED: "guest", PUBLIC: "public" },
}));
vi.mock("@/hooks/store/user", () => ({
  useUser: () => ({ data: state.user, isLoading: false, fetchCurrentUser: vi.fn() }),
  useUserProfile: () => ({ data: { id: "profile", is_onboarded: false } }),
  useUserSettings: () => ({ data: {} }),
}));
vi.mock("@/hooks/store/use-workspace", () => ({ useWorkspace: () => ({ loader: false, workspaces: {} }) }));
vi.mock("@/hooks/use-app-router", () => ({ useAppRouter: () => ({ push: state.push, replace: state.replace }) }));
vi.mock("@/components/common/logo-spinner", () => ({ LogoSpinner: () => <div>Loading</div> }));

const { AuthenticationWrapper } = await import("@/lib/wrappers/authentication-wrapper");
const { EPageTypes } = await import("@/helpers/authentication.helper");
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  state.user = { id: "new-user" };
  state.params = new URLSearchParams();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
});
async function render() {
  await act(async () =>
    root.render(<AuthenticationWrapper pageType={EPageTypes.NON_AUTHENTICATED}>Registration</AuthenticationWrapper>)
  );
}

it("returns a newly registered user to the invitation before onboarding", async () => {
  const invitationPath = "/workspace-invitations/?invitation_id=invite-1&slug=lab&token=signed";
  state.params.set("next_path", invitationPath);
  await render();
  expect(state.replace).toHaveBeenCalledWith(invitationPath);
  expect(state.push).not.toHaveBeenCalled();
});

it("keeps normal onboarding for new accounts without a workspace invitation", async () => {
  state.params.set("next_path", "/lab");
  await render();
  expect(state.push).toHaveBeenCalledWith("/onboarding");
  expect(state.replace).not.toHaveBeenCalled();
});

it("does not treat an external destination as an invitation", async () => {
  state.params.set("next_path", "https://external.example/workspace-invitations/?token=x");
  await render();
  expect(state.replace).not.toHaveBeenCalled();
  expect(state.push).toHaveBeenCalledWith("/onboarding");
});

it("renders registration while the invited user is not signed in", async () => {
  state.user = null;
  state.params.set("next_path", "/workspace-invitations/?token=signed");
  await render();
  expect(container.textContent).toBe("Registration");
  expect(state.replace).not.toHaveBeenCalled();
});
