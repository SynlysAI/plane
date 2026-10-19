// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  profileTabId: undefined as string | undefined,
  query: "",
  research: {
    identity: {
      module_enabled: true,
      workspace_enabled: true,
      user: { org_units: [] as { id: string }[] },
    } as {
      module_enabled: boolean;
      workspace_enabled: boolean;
      user: { org_units: { id: string }[] };
    } | null,
    identityWorkspaceSlug: "lab" as string | null,
    identityErrorCode: null as string | null,
    identityLoader: false,
    isEnabled: true,
    isResearchAdmin: false,
    canConfigurePersonalAgentBackend: false,
    fetchIdentity: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("mobx-react", () => ({
  observer: (component: unknown) => component,
}));
vi.mock("react-router", () => ({
  useParams: () => ({ profileTabId: mocks.profileTabId }),
  useSearchParams: () => [new URLSearchParams(mocks.query)],
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@plane/constants", async () => await vi.importActual("@plane/constants"));
vi.mock("lucide-react", () => ({
  Cpu: () => <span>cpu</span>,
  Plug: () => <span>plug</span>,
}));
vi.mock("@makeplane/propel/icons", () => ({
  KeyOutline: () => null,
  LockOutline: () => null,
  SettingsOutline: () => null,
  SubscribeOutline: () => null,
  UserOutline: () => null,
}));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks.research }));
vi.mock("@/hooks/store/use-workspace", () => ({
  useWorkspace: () => ({
    currentWorkspace: { slug: "lab", name: "Lab" },
    getWorkspaceBySlug: () => ({ name: "Lab" }),
  }),
}));
vi.mock("@/hooks/store/user", () => ({
  useUser: () => ({ data: { id: "user-1" } }),
}));
vi.mock("@/components/research/settings/system/agent-backend-settings", () => ({
  AgentBackendSettings: () => <div>agent-form</div>,
}));
vi.mock("@/components/settings/sidebar/item", () => ({
  SettingsSidebarItem: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));
vi.mock("@/components/settings/profile/sidebar/workspace-options", () => ({
  ProfileSettingsSidebarWorkspaceOptions: () => null,
}));

const { AgentConfigurationProfileSettings } =
  await import("@/components/settings/profile/content/pages/agent-configuration");
const { ProfileSettingsSidebarItemCategories } = await import("@/components/settings/profile/sidebar/item-categories");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  mocks.profileTabId = undefined;
  mocks.query = "";
  mocks.research.identity = {
    module_enabled: true,
    workspace_enabled: true,
    user: { org_units: [] },
  };
  mocks.research.identityWorkspaceSlug = "lab";
  mocks.research.identityErrorCode = null;
  mocks.research.identityLoader = false;
  mocks.research.isEnabled = true;
  mocks.research.isResearchAdmin = false;
  mocks.research.canConfigurePersonalAgentBackend = false;
  mocks.research.fetchIdentity.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("shows a denial instead of loading when identity is rejected", async () => {
  mocks.research.identity = null;
  mocks.research.identityErrorCode = "research_permission_denied";
  await act(async () => root.render(<AgentConfigurationProfileSettings />));

  expect(container.textContent).toContain("research.agent_backend.access_denied");
  expect(container.textContent).not.toContain("research.common.loading");
  expect(container.textContent).not.toContain("agent-form");
});

it("shows a failure instead of loading when identity cannot be fetched", async () => {
  mocks.research.identity = null;
  mocks.research.identityErrorCode = "generic";
  await act(async () => root.render(<AgentConfigurationProfileSettings />));

  expect(container.textContent).toContain("research.agent_backend.load_failed");
  expect(container.textContent).not.toContain("research.common.loading");
});

it("renders the form for a research admin without organisation membership", async () => {
  mocks.research.isResearchAdmin = true;
  mocks.research.canConfigurePersonalAgentBackend = true;
  await act(async () => root.render(<AgentConfigurationProfileSettings />));

  expect(container.textContent).toContain("agent-form");
});

it("shows the sidebar entry for a research admin without organisation membership", async () => {
  mocks.research.isResearchAdmin = true;
  mocks.research.canConfigurePersonalAgentBackend = true;
  await act(async () =>
    root.render(<ProfileSettingsSidebarItemCategories activeTab="general" updateActiveTab={() => undefined} />)
  );

  expect(container.textContent).toContain("profile.actions.agent-configuration");
  const labels = Array.from(container.querySelectorAll("button"), (button) => button.textContent);
  const apiIndex = labels.indexOf("profile.actions.api-tokens");
  expect(labels.slice(apiIndex, apiIndex + 3)).toEqual([
    "profile.actions.api-tokens",
    "profile.actions.mcp",
    "profile.actions.agent-configuration",
  ]);
});

it("hides the sidebar entry when the caller cannot configure a personal backend", async () => {
  mocks.research.canConfigurePersonalAgentBackend = false;
  await act(async () =>
    root.render(<ProfileSettingsSidebarItemCategories activeTab="general" updateActiveTab={() => undefined} />)
  );

  expect(container.textContent).not.toContain("profile.actions.agent-configuration");
  expect(container.textContent).toContain("profile.actions.api-tokens");
  expect(container.textContent).toContain("profile.actions.mcp");
});

it("rechecks sidebar permissions against the workspace selected on the MCP settings page", async () => {
  mocks.profileTabId = "mcp";
  mocks.query = "workspace=second";
  mocks.research.canConfigurePersonalAgentBackend = true;
  await act(async () =>
    root.render(<ProfileSettingsSidebarItemCategories activeTab="mcp" updateActiveTab={() => undefined} />)
  );
  expect(mocks.research.fetchIdentity).toHaveBeenCalledWith("second");
  expect(container.textContent).toContain("profile.actions.mcp");
  expect(container.textContent).not.toContain("profile.actions.agent-configuration");
  mocks.research.identityWorkspaceSlug = "second";
  await act(async () =>
    root.render(<ProfileSettingsSidebarItemCategories activeTab="mcp" updateActiveTab={() => undefined} />)
  );
  expect(container.textContent).toContain("profile.actions.agent-configuration");
});
