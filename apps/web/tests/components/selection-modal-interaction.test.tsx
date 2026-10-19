// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ submit: vi.fn(), addMember: vi.fn(), close: vi.fn() }));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-platform-os", () => ({ usePlatformOS: () => ({ isMobile: false }) }));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({ getProjectById: (id: string) => ({ id, name: "Equipment", identifier: "EQ", logo_props: {} }) }),
}));
vi.mock("@/services/research/navigation.service", () => ({
  ResearchNavigationService: class {
    getAssignableAdministrativeOrganizationMembers = async () => [
      { id: "user-1", name: "Alice", email: "alice@example.test" },
    ];
    addAdministrativeOrganizationMember = mocks.addMember;
  },
}));
vi.mock("@/components/empty-state/simple-empty-state-root", () => ({ SimpleEmptyState: () => null }));
vi.mock("@/components/issues/issue-detail/issue-identifier", () => ({ IssueIdentifier: () => <span>EQ-1</span> }));

import { ProjectMultiSelectModal } from "@/components/project/multi-select-modal";
import { AdministrativeOrganizationManager } from "@/components/research/navigation/administrative-organization-manager";
import { ExistingIssuesListModal } from "@/components/core/modals/existing-issues-list-modal";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.submit.mockResolvedValue(undefined);
  mocks.addMember.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function openOptions() {
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }))
  );
  const option = document.querySelector<HTMLElement>('[role="option"]')!;
  expect(option).not.toBeNull();
  return option;
}

async function openAndSelect() {
  const option = await openOptions();
  await act(async () =>
    option.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }))
  );
}

function interactive(node: HTMLElement) {
  for (let current: HTMLElement | null = node; current; current = current.parentElement) {
    expect(current.inert, `${node.textContent} must remain interactive`).not.toBe(true);
    expect(current.getAttribute("aria-hidden")).not.toBe("true");
  }
}

it("can confirm multiple projects immediately after selecting an option", async () => {
  await act(async () =>
    root.render(
      <ProjectMultiSelectModal
        isOpen
        onClose={mocks.close}
        projectIds={["project-1"]}
        selectedProjectIds={[]}
        onSubmit={mocks.submit}
      />
    )
  );
  await openAndSelect();
  const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === "confirm"
  )!;
  expect(confirm.disabled).toBe(false);
  interactive(confirm);
  await act(async () => confirm.click());
  expect(mocks.submit).toHaveBeenCalledWith(["project-1"]);
});

it("can choose a role and add organization members while the member list stays open", async () => {
  const organization = { id: "org", name: "Office", members: [] } as never;
  await act(async () =>
    root.render(
      <AdministrativeOrganizationManager
        action="members"
        organizationId="org"
        workspaceSlug="lab"
        organizations={[organization]}
        onClose={mocks.close}
        onUpdated={async () => {}}
      />
    )
  );
  await openAndSelect();
  interactive(document.querySelector<HTMLSelectElement>("#organization-member-role")!);
  const add = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === "添加成员"
  )!;
  expect(add.disabled).toBe(false);
  interactive(add);
  await act(async () => add.click());
  expect(mocks.addMember).toHaveBeenCalledWith("lab", "org", "user-1", "MEMBER");
});

it("keeps workspace search controls accessible while selecting related work items", async () => {
  const issue = {
    id: "issue-1",
    name: "Purchase",
    project_id: "project-1",
    project__identifier: "EQ",
    sequence_id: 1,
  } as never;
  await act(async () =>
    root.render(
      <ExistingIssuesListModal
        isOpen
        workspaceSlug="lab"
        projectId="project-1"
        handleClose={mocks.close}
        handleOnSubmit={mocks.submit}
        searchParams={{}}
        workspaceLevelToggle
        workItemSearchServiceCallback={async () => [issue]}
      />
    )
  );
  await openOptions();
  const toggle = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === "common.workspace_level"
  )!;
  expect(toggle).toBeDefined();
  interactive(toggle);
});
