// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type ResearchMock = {
  identity: {
    module_enabled: boolean;
    workspace_enabled: boolean;
    research_ia_v2: boolean;
    sections: { reports: boolean; research_chain: boolean };
    capabilities: { level: string; nav: string[] };
  };
  identityWorkspaceSlug: string;
  isEnabled: boolean;
  isIaV2Enabled: boolean;
  researchLevel: string | null;
  visibleNavKeys: string[] | null;
  canSee: (key: string) => boolean;
  fetchIdentity: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => {
  const research: ResearchMock = {
    identity: {
      module_enabled: true,
      workspace_enabled: true,
      research_ia_v2: true,
      sections: { reports: true, research_chain: true },
      capabilities: { level: "NONE", nav: [] },
    },
    identityWorkspaceSlug: "lab",
    get isEnabled() {
      return Boolean(research.identity.module_enabled && research.identity.workspace_enabled);
    },
    get isIaV2Enabled() {
      return Boolean(research.identity.research_ia_v2);
    },
    get researchLevel() {
      return research.identity.capabilities.level;
    },
    get visibleNavKeys() {
      return research.identity.capabilities.nav;
    },
    canSee: (key: string) => research.identity.capabilities.nav.includes(key),
    fetchIdentity: vi.fn(),
  };
  return { research };
});

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "lab" }),
  usePathname: () => "/lab/projects",
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/use-local-storage", () => ({
  default: () => ({ storedValue: true, setValue: vi.fn() }),
}));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks.research }));
vi.mock("@/hooks/store/use-favorite", () => ({
  useFavorite: () => ({ groupedFavorites: {} }),
}));
vi.mock("@/hooks/store/user", () => ({
  useUserPermissions: () => ({ allowPermissions: () => true }),
}));
vi.mock("@/components/sidebar/sidebar-wrapper", () => ({
  SidebarWrapper: ({ children }: { children: React.ReactNode }) => <aside>{children}</aside>,
}));
vi.mock("@/components/workspace/sidebar/favorites/favorites-menu", () => ({
  SidebarFavoritesMenu: () => <div>favorites-menu</div>,
}));
vi.mock("@/components/workspace/sidebar/projects-list", () => ({
  SidebarProjectsList: () => <div>legacy-projects-list</div>,
}));
vi.mock("@/components/workspace/sidebar/quick-actions", () => ({
  SidebarQuickActions: () => <div>quick-actions</div>,
}));
vi.mock("@/components/workspace/sidebar/sidebar-menu-items", () => ({
  SidebarMenuItems: () => <nav>home-navigation</nav>,
}));
vi.mock("@/components/research/navigation/research-project-tree", () => ({
  ResearchProjectTree: ({ scope }: { scope: string }) => <div data-tree-scope={scope}>{scope}-tree</div>,
}));

const { AppSidebar } = await import("../../app/(all)/[workspaceSlug]/(projects)/sidebar");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.research.identity.module_enabled = true;
  mocks.research.identity.workspace_enabled = true;
  mocks.research.identity.research_ia_v2 = true;
  mocks.research.identity.capabilities = { level: "NONE", nav: [] };
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("keeps the administrative tree for a user without research identity", async () => {
  await act(async () => root.render(<AppSidebar />));

  expect(container.querySelector("[data-tree-scope='ADMINISTRATIVE']")).not.toBeNull();
  expect(container.querySelector("[data-tree-scope='RESEARCH']")).toBeNull();
  expect(container.textContent).not.toContain("legacy-projects-list");
});

it("shows both trees for an active research organization member", async () => {
  mocks.research.identity.capabilities = {
    level: "RESEARCHER",
    nav: ["research_chain", "projects"],
  };
  await act(async () => root.render(<AppSidebar />));

  expect(container.querySelector("[data-tree-scope='RESEARCH']")).not.toBeNull();
  expect(container.querySelector("[data-tree-scope='ADMINISTRATIVE']")).not.toBeNull();
  expect(container.textContent).not.toContain("legacy-projects-list");
});

it("restores the ordinary projects list when IA v2 is disabled", async () => {
  mocks.research.identity.research_ia_v2 = false;
  mocks.research.identity.capabilities = {
    level: "RESEARCHER",
    nav: ["overview", "reports", "projects"],
  };
  await act(async () => root.render(<AppSidebar />));

  expect(container.textContent).toContain("legacy-projects-list");
  expect(container.querySelector("[data-tree-scope='ADMINISTRATIVE']")).toBeNull();
});
