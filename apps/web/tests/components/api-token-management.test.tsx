// @vitest-environment jsdom
/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { SWRConfig } from "swr";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
const calls = vi.hoisted(() => ({
  list: vi.fn(),
  retrieve: vi.fn(),
  create: vi.fn(),
  destroy: vi.fn(),
  rename: vi.fn(),
}));
vi.mock("@plane/services", () => ({
  APITokenService: class {
    list = calls.list;
    retrieve = calls.retrieve;
    create = calls.create;
    destroy = calls.destroy;
    rename = calls.rename;
  },
}));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/propel/button", () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock("@plane/propel/empty-state", () => ({ EmptyStateCompact: () => <div>EMPTY-TOKENS</div> }));
vi.mock("@plane/propel/toast", () => ({ setToast: vi.fn(), TOAST_TYPE: { ERROR: "error", SUCCESS: "success" } }));
vi.mock("@plane/ui", () => ({
  ModalCore: ({ isOpen, children }: any) => (isOpen ? <div role="dialog">{children}</div> : null),
  EModalPosition: { TOP: "top" },
  EModalWidth: { XXL: "xxl" },
  AlertModalCore: ({ isOpen, content, handleClose, handleSubmit }: any) =>
    isOpen ? (
      <div>
        {content}
        <button onClick={handleClose}>cancel-delete</button>
        <button onClick={handleSubmit}>confirm-delete</button>
      </div>
    ) : null,
}));
vi.mock("@/components/settings/profile/heading", () => ({
  ProfileSettingsHeading: ({ control }: any) => <div>{control}</div>,
}));
vi.mock("@/components/ui/loader/settings/api-token", () => ({
  APITokenSettingsLoader: () => <div>LOADING-TOKENS</div>,
}));
vi.mock("@/components/api-token/modal/form", () => ({
  CreateApiTokenForm: ({ onSubmit, handleClose }: any) => (
    <>
      <button onClick={() => void onSubmit({ label: "Fresh" })}>create-now</button>
      <button onClick={handleClose}>close-create</button>
    </>
  ),
}));
vi.mock("@/components/api-token/modal/generated-token-details", () => ({
  GeneratedTokenDetails: ({ tokenDetails, handleClose }: any) => (
    <>
      <p>{tokenDetails.token}</p>
      <button onClick={handleClose}>close-secret</button>
    </>
  ),
}));
import { APITokensProfileSettings } from "@/components/settings/profile/content/pages/api-tokens";
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let cache: Map<string, any>;
const token = {
  id: "owned",
  label: "My token",
  description: "Personal integration",
  created_at: "2026-01-01T00:00:00Z",
  expired_at: null,
  last_used: null,
  is_active: true,
  masked_token: "plane_api_abcd********1234",
};
beforeEach(() => {
  vi.clearAllMocks();
  cache = new Map();
  calls.list.mockResolvedValue([token]);
  calls.retrieve.mockResolvedValue(token);
  calls.destroy.mockResolvedValue(undefined);
  calls.create.mockResolvedValue({ ...token, id: "fresh", token: "SECRET-ONLY-ONCE" });
  calls.rename.mockResolvedValue({ ...token, label: "Renamed" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render() {
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
        <APITokensProfileSettings />
      </SWRConfig>
    )
  );
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === text || item.getAttribute("aria-label") === text
  )!;
  expect(button, text).toBeTruthy();
  await act(async () => button.click());
}
it("renders a masked-key table with rename/delete controls and no tracking ID or secret recovery", async () => {
  calls.list.mockResolvedValue([{ ...token, token: "SERVER-ACCIDENTAL-SECRET" }]);
  await render();
  expect(container.querySelectorAll("th")).toHaveLength(5);
  expect(container.textContent).toContain("api_token_management.created_date");
  expect(container.textContent).toContain(token.masked_token);
  expect(container.textContent).toContain("2026-01-01");
  expect(container.textContent).not.toContain("Personal integration");
  expect(container.innerHTML).not.toContain(token.id);
  expect(container.textContent).not.toContain("Tracking ID");
  expect(container.textContent).not.toContain("api_token_management.details");
  expect(container.querySelector("button.hidden")).toBeNull();
  expect(container.querySelector('[aria-label="api_token_management.rename My token"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="delete My token"]')).not.toBeNull();
  expect(calls.retrieve).not.toHaveBeenCalled();
  expect(container.innerHTML).not.toContain("SERVER-ACCIDENTAL-SECRET");
});
async function renameInput(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="api_token_management.token_name"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}
it("renames only the label, prevents duplicate submissions and never caches a secret", async () => {
  let resolve!: (value: unknown) => void;
  calls.rename.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  await render();
  await click("api_token_management.rename My token");
  const input = await renameInput("  Renamed  ");
  await act(async () => {
    input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(calls.rename).toHaveBeenCalledExactlyOnceWith("owned", "Renamed");
  calls.list.mockResolvedValue([{ ...token, label: "Renamed" }]);
  await act(async () => resolve({ ...token, label: "Renamed", token: "NEVER-CACHE-RENAME-SECRET" }));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain("Renamed");
  expect(JSON.stringify([...cache.entries()])).not.toContain("NEVER-CACHE-RENAME-SECRET");
  expect(container.innerHTML).not.toContain("NEVER-CACHE-RENAME-SECRET");
});
it("rejects blank names, retains the original record on rename failure and permits retry", async () => {
  await render();
  await click("api_token_management.rename My token");
  const input = await renameInput("   ");
  await act(async () => {
    input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(calls.rename).not.toHaveBeenCalled();
  expect(container.textContent).toContain("api_token_management.name_required");
  await renameInput("Renamed");
  calls.rename.mockRejectedValueOnce({ status: 403 });
  await click("save");
  expect(container.textContent).toContain("api_token_management.forbidden");
  expect(container.querySelector("tbody")?.textContent).toContain("My token");
  calls.list.mockResolvedValue([{ ...token, label: "Renamed" }]);
  await click("save");
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain("Renamed");
});
it.each([
  [500, "load_error"],
  [401, "login_expired"],
  [403, "forbidden"],
])("handles request failure %s explicitly", async (status, message) => {
  calls.list.mockRejectedValue({ status });
  await render();
  expect(container.textContent).toContain(`api_token_management.${message}`);
  expect(container.textContent).not.toContain("LOADING-TOKENS");
  if (status === 401) expect(container.querySelector('a[href="/"]')).not.toBeNull();
  else {
    calls.list.mockResolvedValue([token]);
    await click("api_token_management.retry");
    expect(container.textContent).toContain("My token");
  }
});
it("shows empty state only after a successful empty response", async () => {
  calls.list.mockResolvedValue([]);
  await render();
  expect(container.textContent).toContain("EMPTY-TOKENS");
});
it("preserves record on failed deletion, prevents duplicate submissions, then refreshes after success", async () => {
  let reject!: (error: unknown) => void;
  calls.destroy.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      })
  );
  await render();
  await click("delete My token");
  expect(calls.destroy).not.toHaveBeenCalled();
  await click("confirm-delete");
  await click("confirm-delete");
  expect(calls.destroy).toHaveBeenCalledTimes(1);
  await act(async () => reject({ error: "Synthetic deletion denied" }));
  expect(container.textContent).toContain("Synthetic deletion denied");
  expect(container.textContent).toContain("My token");
  calls.list.mockResolvedValue([]);
  await click("confirm-delete");
  expect(calls.list.mock.calls.length).toBeGreaterThan(1);
  expect(container.textContent).toContain("EMPTY-TOKENS");
});
it("never stores creation secret in the list cache and clears it synchronously on close", async () => {
  await render();
  await click("workspace_settings.settings.api_tokens.add_token");
  await click("create-now");
  expect(container.textContent).toContain("SECRET-ONLY-ONCE");
  expect(JSON.stringify([...cache.entries()])).not.toContain("SECRET-ONLY-ONCE");
  await click("close-secret");
  expect(container.textContent).not.toContain("SECRET-ONLY-ONCE");
  await click("workspace_settings.settings.api_tokens.add_token");
  expect(container.textContent).not.toContain("SECRET-ONLY-ONCE");
});
it("does not reopen a secret from a delayed creation after closing", async () => {
  let resolve!: (value: unknown) => void;
  calls.create.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  await render();
  await click("workspace_settings.settings.api_tokens.add_token");
  await click("create-now");
  await click("close-create");
  await act(async () => resolve({ ...token, token: "DELAYED-SECRET" }));
  await click("workspace_settings.settings.api_tokens.add_token");
  expect(container.textContent).not.toContain("DELAYED-SECRET");
});
