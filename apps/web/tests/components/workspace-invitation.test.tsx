// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: null as { id?: string; email?: string } | null,
  invitation: {
    id: "invitation-1",
    email: "invite1@example.com",
    workspace: { slug: "lab", name: "Lab" },
    responded_at: null,
  },
  params: new URLSearchParams(),
  push: vi.fn(),
  replace: vi.fn(),
  join: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/navigation", () => ({ useSearchParams: () => state.params }));
vi.mock("swr", () => ({ default: () => ({ data: state.invitation }) }));
vi.mock("@plane/constants", () => ({ API_BASE_URL: "", WORKSPACE_INVITATION: (id: string) => id }));
vi.mock("@/helpers/authentication.helper", () => ({ EPageTypes: { PUBLIC: "public" } }));
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: state.user }) }));
vi.mock("@/hooks/use-app-router", () => ({ useAppRouter: () => ({ push: state.push, replace: state.replace }) }));
vi.mock("@/lib/wrappers/authentication-wrapper", () => ({
  AuthenticationWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/services/workspace.service", () => ({
  WorkspaceService: class {
    joinWorkspace = state.join;
  },
}));
vi.mock("@/services/auth.service", () => ({
  AuthService: class {
    signOut = state.signOut;
  },
}));
vi.mock("@/components/common/logo-spinner", () => ({ LogoSpinner: () => <div>Loading</div> }));
vi.mock("@/components/ui/empty-space", () => ({
  EmptySpace: ({ title, description, children }: { title: string; description: string; children: React.ReactNode }) => (
    <div>
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </div>
  ),
  EmptySpaceItem: ({ title, action }: { title: string; action?: () => void }) => (
    <button onClick={action}>{title}</button>
  ),
}));

const { default: WorkspaceInvitationPage } = await import("../../app/(all)/workspace-invitations/page");
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  state.user = null;
  state.params = new URLSearchParams({ invitation_id: "invitation-1", slug: "lab", token: "signed.token+value=" });
  state.join.mockResolvedValue({});
  state.signOut.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function render() {
  await act(async () => root.render(<WorkspaceInvitationPage />));
}

async function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

it("opens registration with the invited email and a complete return link", async () => {
  await render();
  const url = new URL(state.replace.mock.calls[0][0], "http://localhost");
  expect(url.pathname).toBe("/sign-up");
  expect(url.searchParams.get("email")).toBe("invite1@example.com");
  expect(url.searchParams.get("slug")).toBe("lab");
  const returnUrl = new URL(url.searchParams.get("next_path")!, url.origin);
  expect(returnUrl.searchParams.get("token")).toBe("signed.token+value=");
  expect(returnUrl.searchParams.get("invitation_id")).toBe("invitation-1");
  expect(container.textContent).not.toContain("Accept");
  expect(state.join).not.toHaveBeenCalled();
});

it("offers account switching for a different signed-in email and retains the invitation on sign-out", async () => {
  state.user = { id: "admin", email: "admin@example.com" };
  await render();
  expect(container.textContent).toContain("invite1@example.com");
  expect(container.textContent).toContain("admin@example.com");
  expect(container.textContent).not.toContain("Accept");
  await click("Switch account to continue");
  expect(state.signOut).toHaveBeenCalledWith("", expect.stringContaining("/workspace-invitations/"));
  const returnUrl = new URL(state.signOut.mock.calls[0][1], "http://localhost");
  expect(returnUrl.searchParams.get("token")).toBe("signed.token+value=");
  expect(state.join).not.toHaveBeenCalled();
});

it("accepts after authenticating as the invited user, ignoring email casing", async () => {
  state.user = { id: "invitee", email: "INVITE1@example.com" };
  await render();
  await click("Accept");
  expect(state.join).toHaveBeenCalledWith("lab", "invitation-1", { accepted: true, token: "signed.token+value=" });
  expect(state.push).toHaveBeenCalledWith("/lab");
});

it("only declines an invitation as the invited user", async () => {
  state.user = { id: "invitee", email: "invite1@example.com" };
  await render();
  await click("Ignore");
  expect(state.join).toHaveBeenCalledWith("lab", "invitation-1", { accepted: false, token: "signed.token+value=" });
  expect(state.push).toHaveBeenCalledWith("/");
});

it("shows an error and permits retry when acceptance fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  state.user = { id: "invitee", email: "invite1@example.com" };
  state.join.mockRejectedValueOnce(new Error("Network unavailable"));
  await render();
  await click("Accept");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Please try again");
  expect(state.push).not.toHaveBeenCalled();
  await click("Accept");
  expect(state.push).toHaveBeenCalledWith("/lab");
});

it("does not offer registration or acceptance when the link has no token", async () => {
  state.params.delete("token");
  await render();
  expect(container.textContent).toContain("not active anymore");
  expect(state.replace).not.toHaveBeenCalled();
  expect(state.join).not.toHaveBeenCalled();
});

it("treats a user response without an account id as unauthenticated", async () => {
  state.user = {};
  await render();
  expect(state.replace).toHaveBeenCalledWith(expect.stringContaining("/sign-up?"));
  expect(container.textContent).not.toContain("Switch account");
});
