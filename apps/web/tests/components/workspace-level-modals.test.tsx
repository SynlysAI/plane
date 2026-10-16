// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isCreateProjectModalOpen: true,
  toggleCreateProjectModal: vi.fn(),
  research: {
    isEnabled: true,
    isIaV2Enabled: true,
  },
  captured: [] as Array<{ isOpen: boolean; administrative?: boolean }>,
}));

vi.mock("mobx-react", () => ({
  enableStaticRendering: () => undefined,
  observer: (component: unknown) => component,
}));
vi.mock("@/components/project/create-project-modal", () => ({
  CreateProjectModal: (props: { isOpen: boolean; administrative?: boolean }) => {
    mocks.captured.push(props);
    return props.isOpen ? (
      <div data-testid="create-project-modal" data-administrative={String(Boolean(props.administrative))} />
    ) : null;
  },
}));
vi.mock("@/hooks/store/use-command-palette", () => ({
  useCommandPalette: () => ({
    isCreateProjectModalOpen: mocks.isCreateProjectModalOpen,
    toggleCreateProjectModal: mocks.toggleCreateProjectModal,
  }),
}));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks.research }));

const { WorkspaceLevelModals } = await import("@/components/modals/workspace-level");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.isCreateProjectModalOpen = true;
  mocks.research.isEnabled = true;
  mocks.research.isIaV2Enabled = true;
  mocks.captured = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function renderModals() {
  act(() => {
    root.render(<WorkspaceLevelModals workspaceSlug="lab" />);
  });
}

function administrative() {
  renderModals();
  return container.querySelector('[data-testid="create-project-modal"]')?.getAttribute("data-administrative");
}

it("always shows the administrative form when IA v2 is enabled", () => {
  expect(administrative()).toBe("true");
  expect(mocks.captured.at(-1)).toMatchObject({ isOpen: true, administrative: true });
});

it("keeps the legacy form when IA v2 is disabled", () => {
  mocks.research.isIaV2Enabled = false;
  expect(administrative()).toBe("false");
  expect(mocks.captured.at(-1)).toMatchObject({ isOpen: true, administrative: false });
});

it("passes the modal open state through", () => {
  mocks.isCreateProjectModalOpen = false;
  renderModals();
  expect(container.querySelector('[data-testid="create-project-modal"]')).toBeNull();
  expect(mocks.captured.at(-1)).toMatchObject({ isOpen: false });
});
