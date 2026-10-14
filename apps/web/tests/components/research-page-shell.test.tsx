// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  research: {
    identityWorkspaceSlug: "lab",
    identity: {
      module_enabled: true,
      workspace_enabled: true,
      research_ia_v2: true,
      sections: { reports: true },
    },
    isEnabled: true,
    isIaV2Enabled: true,
    identityLoader: false,
    identityErrorCode: null as string | null,
    isResearchAdmin: false,
    canSee: (key: string): boolean => key === "projects",
    fetchIdentity: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("mobx-react", () => ({
  observer: (component: unknown) => component,
}));
vi.mock("react-router", () => ({ useParams: () => ({ workspaceSlug: "lab" }) }));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@plane/ui", () => ({
  Spinner: () => <div>spinner</div>,
}));
vi.mock("@/components/core/page-title", () => ({ PageHead: () => null }));
vi.mock("@/components/research/common/research-status-panel", () => ({
  ResearchStatusPanel: ({ status }: { status: string }) => <div>status-panel:{status}</div>,
}));
vi.mock("@/components/research/navigation/research-management-tabs", () => ({
  ResearchManagementTabs: () => <div>management-tabs</div>,
}));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks.research }));
vi.mock("@/hooks/store/use-workspace", () => ({
  useWorkspace: () => ({ getWorkspaceBySlug: () => ({ name: "Lab" }) }),
}));

const { ResearchPageShell } = await import("@/components/research/common/research-page-shell");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  mocks.research.identityLoader = false;
  mocks.research.identityErrorCode = null;
  mocks.research.identityWorkspaceSlug = "lab";
  mocks.research.identity.module_enabled = true;
  mocks.research.identity.workspace_enabled = true;
  mocks.research.isEnabled = true;
  mocks.research.canSee = (key: string): boolean => key === "projects";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("still enforces permission when embedded and does not render the page header", async () => {
  await act(async () =>
    root.render(
      <ResearchPageShell titleKey="research.nav.projects" section="reports" navKey="projects" embedded>
        <div>research-body</div>
      </ResearchPageShell>
    )
  );

  expect(container.textContent).toContain("research-body");
  expect(container.querySelector("h2")).toBeNull();
  expect(container.textContent).not.toContain("management-tabs");
});

it("renders the permission panel instead of children when the nav key is denied", async () => {
  mocks.research.canSee = () => false;
  await act(async () =>
    root.render(
      <ResearchPageShell titleKey="research.nav.projects" section="reports" navKey="projects" embedded>
        <div>research-body</div>
      </ResearchPageShell>
    )
  );

  expect(container.textContent).toContain("status-panel:permission_denied");
  expect(container.textContent).not.toContain("research-body");
});

it("shows a spinner while identity is loading even when embedded", async () => {
  mocks.research.identityLoader = true;
  await act(async () =>
    root.render(
      <ResearchPageShell titleKey="research.nav.projects" section="reports" navKey="projects" embedded>
        <div>research-body</div>
      </ResearchPageShell>
    )
  );

  expect(container.textContent).toContain("spinner");
  expect(container.textContent).not.toContain("research-body");
});
