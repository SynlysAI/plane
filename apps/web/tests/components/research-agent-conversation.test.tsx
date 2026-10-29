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
const uploadFiles = vi.fn();

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

it("sends every selected ScienceDiscovery session file in one batch", async () => {
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
    uploadedFiles: [],
    failedUploads: [],
    reportError: "",
    uploadFiles,
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

  expect(uploadFiles).toHaveBeenCalledTimes(1);
  expect(uploadFiles.mock.calls[0][0].map((file: File) => file.name)).toEqual(["first.csv", "second.csv"]);
});

it("shows failed ScienceDiscovery files and retries one file at a time", async () => {
  const failedFile = new File(["failed"], "failed.csv", { type: "text/csv" });
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
    uploadError: "上游拒绝文件",
    uploadedFiles: ["success.csv"],
    failedUploads: [{ file: failedFile, message: "上游拒绝文件" }],
    reportError: "",
    uploadFiles,
  } as unknown as TResearchAgentSessionApi;

  await act(async () => root.render(<ResearchAgentConversation api={api} />));
  expect(container.textContent).toContain("success.csv 已上传！");
  expect(container.textContent).toContain("failed.csv");

  await act(async () => {
    const retry = container.querySelector<HTMLButtonElement>('button[aria-label="重试上传"]');
    if (!retry) throw new Error("缺少失败文件重试按钮");
    retry.click();
  });

  expect(uploadFiles).toHaveBeenCalledWith([failedFile]);
});
