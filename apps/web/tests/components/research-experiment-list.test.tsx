// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const records: Array<Record<string, unknown>> = [];
const research = vi.hoisted(() => ({
  getExperiments: vi.fn(),
  fetchExperiments: vi.fn(),
  createExperiment: vi.fn(),
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => research }));
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: { id: "user-1" } }) }));
vi.mock("@/components/research/experiments/experiment-detail", () => ({
  ExperimentDetail: () => <div>experiment-detail</div>,
}));
vi.mock("@/components/research/common/error-messages", () => ({ getResearchErrorKey: () => "research.common.error" }));
vi.mock("@/components/research/common/research-status-badge", () => ({
  ResearchStatusBadge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@plane/constants", () => ({
  EXPERIMENT_STATUSES: ["PLANNED"],
  EXPERIMENT_STATUS_LABELS: { PLANNED: "research.experiments.status.planned" },
  EXPERIMENT_SOURCE_LABELS: { MANUAL: "research.experiments.source.manual" },
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key.split(".").reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], translations) ?? key,
    currentLocale: "zh-CN",
  }),
}));
vi.mock("@plane/propel/button", () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("@plane/ui", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

import { ExperimentList } from "@/components/research/experiments/experiment-list";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  records.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  research.getExperiments.mockImplementation((_slug: string, projectId: string) =>
    projectId === "project-1" ? records : []
  );
  research.fetchExperiments.mockImplementation(async (_slug: string, projectId: string) =>
    projectId === "project-1" ? records : []
  );
  research.createExperiment.mockImplementation(async (_slug: string, projectId: string, payload: { title: string }) => {
    const record = {
      id: "exp-1",
      sequence_no: 1,
      title: payload.title,
      status: "PLANNED",
      source: "MANUAL",
      project: projectId,
      updated_at: "2026-09-27T00:00:00Z",
    };
    if (projectId === "project-1") records.push(record);
    return record;
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderList() {
  await act(async () => {
    root.render(<ExperimentList workspaceSlug="lab" projectId="project-1" />);
  });
}

describe("experiment phase boundary", () => {
  it("explains that only manual records can be created while SpecLabOS is off", async () => {
    await renderList();
    expect(container.textContent).toContain("本阶段可以新建人工记录。SpecLabOS 未启用，不能同步运行记录。");
    expect(container.textContent).not.toContain("还没有登记实验");
    expect(container.textContent).not.toContain("选择一条实验查看详情");
    expect(container.querySelector('input[placeholder="实验标题"]')).not.toBeNull();
    expect(research.fetchExperiments).toHaveBeenCalledWith("lab", "project-1", {});
  });

  it("keeps a newly created record on the current project", async () => {
    await renderList();
    const input = container.querySelector('input[placeholder="实验标题"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "对照实验");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "登记实验")?.click();
    });
    expect(research.createExperiment).toHaveBeenCalledWith("lab", "project-1", { title: "对照实验" });
    expect(container.textContent).toContain("#1 对照实验");
    expect(container.textContent).toContain("experiment-detail");
    expect(research.getExperiments).toHaveBeenCalledWith("lab", "project-1");
  });
});
