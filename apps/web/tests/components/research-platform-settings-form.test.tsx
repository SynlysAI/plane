// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";
import { resolveMainPiName } from "@/components/research/settings/platform/platform-settings-form";

const LONG_ID = "11111111-2222-4333-8444-555555555555";
const service = vi.hoisted(() => ({
  lookupMainPi: vi.fn(),
}));
const research = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  fetchIdentity: vi.fn(),
  identity: { user: { is_system_admin: true } } as { user: { is_system_admin: boolean } } | null,
}));

vi.mock("@/services/research/platform.service", () => ({
  ResearchPlatformService: class {
    lookupMainPi = service.lookupMainPi;
  },
}));
vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => research }));
vi.mock("@/components/research/common/error-messages", () => ({
  getResearchErrorKey: () => "research.common.error",
}));
vi.mock("@plane/constants", () => ({
  REPORT_VISIBILITIES: ["DIRECT_ADVISOR"],
  REPORT_VISIBILITY_LABELS: { DIRECT_ADVISOR: "research.visibility.direct_advisor" },
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key.split(".").reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], translations) ?? key,
  }),
}));
vi.mock("@plane/propel/button", () => ({
  Button: ({ children }: { children?: React.ReactNode }) => <button type="button">{children}</button>,
}));
vi.mock("@plane/ui", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

import { ResearchPlatformSettingsForm } from "@/components/research/settings/platform/platform-settings-form";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

const settings = {
  purpose: "PUBLIC_RESEARCH",
  main_pi: LONG_ID,
  main_pi_name: "邱智鑫",
  required_reporter_categories: ["STUDENT"],
  module_enabled: true,
  org_enabled: true,
  report_enabled: true,
  approval_enabled: true,
  research_chain_enabled: true,
  research_ia_v2: true,
  allow_multiple_projects: false,
  default_report_visibility: "DIRECT_ADVISOR",
  weekly_default_visibility: null,
  monthly_default_visibility: null,
  image_max_mb: 20,
  pdf_max_mb: 100,
  markdown_max_mb: 5,
  timezone: "Asia/Shanghai",
  audit_retention_days: 0,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  research.identity = { user: { is_system_admin: true } };
  research.fetchSettings.mockResolvedValue(settings);
  service.lookupMainPi.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function renderForm() {
  await act(async () => {
    root.render(<ResearchPlatformSettingsForm workspaceSlug="lab" />);
  });
}

function mainPiInput() {
  return container.querySelector('input[aria-label="主 PI"]') as HTMLInputElement;
}

function resolvedName() {
  return container.querySelector("[data-testid='main-pi-resolved-name']");
}

async function replaceValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("main PI name resolution", () => {
  it("uses the saved display name and never the account id", () => {
    expect(resolveMainPiName({ value: LONG_ID, savedId: LONG_ID, savedName: "邱智鑫", lookup: null })).toEqual({
      state: "resolved",
      name: "邱智鑫",
    });
    expect(resolveMainPiName({ value: LONG_ID, savedId: LONG_ID, savedName: LONG_ID, lookup: null })).toEqual({
      state: "missing",
      name: null,
    });
    expect(resolveMainPiName({ value: "", savedId: LONG_ID, savedName: "邱智鑫", lookup: null })).toEqual({
      state: "hidden",
      name: null,
    });
  });

  it("waits for lookup on a new value and rejects a missing user", () => {
    expect(
      resolveMainPiName({ value: "someone@example.com", savedId: LONG_ID, savedName: "邱智鑫", lookup: null })
    ).toEqual({
      state: "hidden",
      name: null,
    });
    expect(
      resolveMainPiName({
        value: "someone@example.com",
        savedId: LONG_ID,
        savedName: "邱智鑫",
        lookup: { found: false, name: null },
      })
    ).toEqual({ state: "missing", name: null });
    expect(
      resolveMainPiName({
        value: "someone@example.com",
        savedId: LONG_ID,
        savedName: "邱智鑫",
        lookup: { found: true, name: "李老师" },
      })
    ).toEqual({ state: "resolved", name: "李老师" });
  });
});

describe("platform settings main PI field", () => {
  it("keeps the full account id inside a field as tall as the number inputs", async () => {
    await renderForm();
    const input = mainPiInput();
    expect(input.value).toBe(LONG_ID);
    expect(input.className).toContain("h-9");
    expect(input.className).toContain("leading-8");
    expect(input.className).toContain("py-0");
    expect(input.className).toContain("overflow-x-auto");
    expect(input.className).toContain("min-w-0");
    expect(resolvedName()?.textContent).toBe("邱智鑫");
    expect(container.textContent).not.toContain(LONG_ID);
    const numbers = Array.from(container.querySelectorAll('input[type="number"]'));
    expect(numbers).toHaveLength(4);
    numbers.forEach((item) => {
      expect(item.className).toContain("h-9");
      expect(item.className).toContain("leading-8");
      expect(item.className).toContain("py-0");
    });
    expect(container.firstElementChild?.className).toContain("overflow-x-hidden");
    expect(service.lookupMainPi).not.toHaveBeenCalled();
  });

  it("shows that a changed account was not found and does not use the raw id as a name", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    service.lookupMainPi.mockResolvedValue({ lookup_user_found: false, lookup_user_name: null });
    await renderForm();
    await replaceValue(mainPiInput(), "not-a-user");
    expect(resolvedName()).toBeNull();
    expect(service.lookupMainPi).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(service.lookupMainPi).toHaveBeenCalledWith("lab", "not-a-user");
    expect(resolvedName()?.textContent).toBe("未找到用户");
    expect(container.textContent).not.toContain("not-a-user");
  });

  it("shows the looked up display name and clears it when the field is emptied", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    service.lookupMainPi.mockResolvedValue({ lookup_user_found: true, lookup_user_name: "李老师" });
    await renderForm();
    await replaceValue(mainPiInput(), "teacher@example.com");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(resolvedName()?.textContent).toBe("李老师");
    await replaceValue(mainPiInput(), "");
    expect(mainPiInput().value).toBe("");
    expect(resolvedName()).toBeNull();
  });

  it("hides the appointment field from anyone who is not a system administrator", async () => {
    research.identity = { user: { is_system_admin: false } };
    await renderForm();
    expect(mainPiInput()).toBeNull();
    expect(resolvedName()).toBeNull();
  });
});
