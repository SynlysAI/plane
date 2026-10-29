// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";
import type { TResearchAgentSessionApi } from "@/components/research/agent/use-research-agent-session";

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) => {
      const value = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      if (typeof value !== "string") return key;
      return value.replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name] ?? ""));
    },
  }),
}));
vi.mock("@plane/propel/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@/components/research/agent/report-context-selector", () => ({
  ReportContextSelector: () => null,
}));

const { ResearchAgentConversation } = await import("@/components/research/agent/research-agent-conversation");

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: Root;
const uploadFile = vi.fn();

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("keeps ScienceDiscovery session upload single-file and rejects batches", async () => {
  const api = {
    events: [],
    userEcho: [],
    state: "ready",
    session: {
      session_id: "session-1",
      status: "READY",
      provider: "SCIENCE_DISCOVERY",
    },
    message: "",
    setMessage: vi.fn(),
    sending: false,
    uploadingFile: false,
    uploadError: "",
    uploadedFile: null,
    reportError: "",
    uploadFile,
  } as unknown as TResearchAgentSessionApi;

  await act(async () => root.render(<ResearchAgentConversation api={api} />));
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("Agent 上传入口未显示");
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [
        new File(["first"], "first.csv", { type: "text/csv" }),
        new File(["second"], "second.csv", { type: "text/csv" }),
      ],
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => await Promise.resolve());

  expect(container.textContent).toContain("仅支持选择一个文件。");
  expect(uploadFile).not.toHaveBeenCalled();
});
