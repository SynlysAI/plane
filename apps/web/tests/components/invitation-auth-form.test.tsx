// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  params: new URLSearchParams(),
  emailCheck: vi.fn(),
  push: vi.fn(),
}));
vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/navigation", () => ({ useSearchParams: () => state.params }));
vi.mock("@/helpers/authentication.helper", () => ({ authErrorHandler: vi.fn() }));
vi.mock("@/hooks/store/use-instance", () => ({ useInstance: () => ({ config: { enable_signup: false } }) }));
vi.mock("@/hooks/use-app-router", () => ({ useAppRouter: () => ({ push: state.push }) }));
vi.mock("@/services/auth.service", () => ({
  AuthService: class {
    emailCheck = state.emailCheck;
  },
}));
vi.mock("@/components/account/auth-forms/email", () => ({
  AuthEmailForm: ({
    defaultEmail,
    onSubmit,
    inviteOnly,
  }: {
    defaultEmail: string;
    onSubmit: (data: { email: string }) => Promise<void>;
    inviteOnly: boolean;
  }) => (
    <button data-invite-only={inviteOnly} onClick={() => void onSubmit({ email: defaultEmail })}>
      Continue
    </button>
  ),
}));
vi.mock("@/components/account/auth-forms/password", () => ({
  AuthPasswordForm: ({
    mode,
    nextPath,
    isEmailInvited,
    handleEmailClear,
  }: {
    mode: string;
    nextPath: string;
    isEmailInvited: boolean;
    handleEmailClear: () => void;
  }) => (
    <div data-mode={mode} data-invited={isEmailInvited}>
      <input name="next_path" value={nextPath} readOnly />
      <button onClick={handleEmailClear}>Clear</button>
    </div>
  ),
}));
vi.mock("@/components/account/auth-forms/unique-code", () => ({
  AuthUniqueCodeForm: () => <div>Code</div>,
}));

const { EAuthModes, EAuthSteps } = await import("@plane/constants");
const { AuthFormRoot } = await import("@/components/account/auth-forms/form-root");
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function Form() {
  const [mode, setMode] = useState(EAuthModes.SIGN_UP);
  const [step, setStep] = useState(EAuthSteps.EMAIL);
  const [email, setEmail] = useState("invite@example.com");
  return (
    <AuthFormRoot
      authMode={mode}
      authStep={step}
      email={email}
      setEmail={setEmail}
      setAuthMode={setMode}
      setAuthStep={setStep}
      setErrorInfo={() => undefined}
      currentAuthMode={EAuthModes.SIGN_UP}
    />
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  state.params = new URLSearchParams({
    invitation_id: "invite-1",
    slug: "lab",
    next_path: "/workspace-invitations/?invitation_id=invite-1&slug=lab&token=signed",
  });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
});

async function continueWithEmail() {
  await act(async () => root.render(<Form />));
  await act(async () => container.querySelector("button")?.click());
}

it("permits an invited new email to register without an additional invite code", async () => {
  state.emailCheck.mockResolvedValue({ existing: false, invited: true, status: "CREDENTIAL" });
  await act(async () => root.render(<Form />));
  expect(container.querySelector("button")?.getAttribute("data-invite-only")).toBe("false");
  await act(async () => container.querySelector("button")?.click());
  expect(container.querySelector("[data-mode]")?.getAttribute("data-mode")).toBe(EAuthModes.SIGN_UP);
  expect(container.querySelector("[data-invited]")?.getAttribute("data-invited")).toBe("true");
  expect(container.querySelector<HTMLInputElement>('input[name="next_path"]')?.value).toBe(
    state.params.get("next_path")
  );
});

it("automatically signs in an existing account instead of attempting registration", async () => {
  state.emailCheck.mockResolvedValue({ existing: true, status: "CREDENTIAL" });
  await continueWithEmail();
  expect(container.querySelector("[data-mode]")?.getAttribute("data-mode")).toBe(EAuthModes.SIGN_IN);
});

it("keeps the invitation return link when clearing the email", async () => {
  state.emailCheck.mockResolvedValue({ existing: false, invited: true, status: "CREDENTIAL" });
  await continueWithEmail();
  await act(async () => container.querySelector("button")?.click());
  const destination = new URL(state.push.mock.calls[0][0], "http://localhost");
  expect(destination.pathname).toBe("/sign-up");
  expect(destination.searchParams.get("next_path")).toBe(state.params.get("next_path"));
  expect(destination.searchParams.get("invitation_id")).toBe("invite-1");
});
