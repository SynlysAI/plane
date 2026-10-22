// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const memberControl = vi.hoisted(() => ({ onChange: null as ((value: string | null) => void) | null }));

vi.mock("next/navigation", () => ({ useParams: () => ({ workspaceSlug: "lab" }) }));
vi.mock("@makeplane/propel/icons", () => ({
  DueDateOutline: () => <span />,
  StartDateOutline: () => <span />,
}));
vi.mock("@plane/utils", () => ({
  getDate: () => null,
  renderFormattedPayloadDate: () => "2026-10-21",
  shouldHighlightIssueDueDate: () => false,
}));
vi.mock("@/components/dropdowns/member/dropdown", () => ({
  MemberDropdown: (props: { onChange: (value: string | null) => void }) => {
    memberControl.onChange = props.onChange;
    return (
      <div>
        <button type="button" onClick={() => props.onChange("member-1")}>
          选择负责人
        </button>
        <button type="button" onClick={() => props.onChange(null)}>
          清空负责人
        </button>
      </div>
    );
  },
}));
vi.mock("@/components/dropdowns/cycle", () => ({ CycleDropdown: () => <div /> }));
vi.mock("@/components/dropdowns/date", () => ({ DateDropdown: () => <div /> }));
vi.mock("@/components/dropdowns/estimate", () => ({ EstimateDropdown: () => <div /> }));
vi.mock("@/components/dropdowns/module/dropdown", () => ({ ModuleDropdown: () => <div /> }));
vi.mock("@/components/dropdowns/priority", () => ({ PriorityDropdown: () => <div /> }));
vi.mock("@/components/dropdowns/state/dropdown", () => ({ StateDropdown: () => <div /> }));
vi.mock("@/hooks/store/estimates", () => ({
  useProjectEstimates: () => ({ areEstimateEnabledByProjectId: () => false }),
}));
vi.mock("@/hooks/store/use-label", () => ({ useLabel: () => ({ labelMap: {} }) }));
vi.mock("@/hooks/store/use-project", () => ({ useProject: () => ({ getProjectById: () => null }) }));
vi.mock("@/hooks/store/use-project-state", () => ({ useProjectState: () => ({ getStateById: () => undefined }) }));
vi.mock("@/hooks/store/workspace-draft", () => ({
  useWorkspaceDraftIssues: () => ({ addCycleToIssue: vi.fn(), addModulesToIssue: vi.fn() }),
}));
vi.mock("@/hooks/use-platform-os", () => ({ usePlatformOS: () => ({ isMobile: false }) }));
vi.mock("@/components/issues/issue-layouts/properties", () => ({ IssuePropertyLabels: () => <div /> }));

const { DraftIssueProperties } = await import("@/components/issues/workspace-draft/draft-issue-properties");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const updateIssue = vi.fn();
const issue = {
  id: "issue-1",
  project_id: "project-1",
  state_id: "state-1",
  priority: "none",
  label_ids: [],
  assignee_ids: [],
} as never;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  updateIssue.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("submits exactly one assignee or an empty array from the single-select control", async () => {
  await act(async () => root.render(<DraftIssueProperties issue={issue} updateIssue={updateIssue} className="" />));

  await act(async () =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === "选择负责人")?.click()
  );
  expect(updateIssue).toHaveBeenCalledWith("project-1", "issue-1", { assignee_ids: ["member-1"] });

  await act(async () =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === "清空负责人")?.click()
  );
  expect(updateIssue).toHaveBeenLastCalledWith("project-1", "issue-1", { assignee_ids: [] });
});
