// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  research: {
    isEnabled: true,
    isIaV2Enabled: true,
  },
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/navigation", () => ({ usePathname: () => "/lab/projects" }));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/propel/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@plane/ui", () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const Breadcrumbs = ({ children }: { children: React.ReactNode }) => <nav>{children}</nav>;
  Breadcrumbs.Item = ({ component }: { component: React.ReactNode }) => <div>{component}</div>;
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const Header = ({ children }: { children: React.ReactNode }) => <header>{children}</header>;
  Header.LeftItem = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Header.RightItem = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return { Breadcrumbs, Header };
});
vi.mock("@/components/common/breadcrumb-link", () => ({
  BreadcrumbLink: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("@/components/project/filters", () => ({ default: () => <div>project-filters</div> }));
vi.mock("@/components/project/search-projects", () => ({ ProjectSearch: () => <div>project-search</div> }));
vi.mock("@/hooks/store/use-command-palette", () => ({
  useCommandPalette: () => ({ toggleCreateProjectModal: vi.fn() }),
}));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks.research }));
vi.mock("@/hooks/store/user", () => ({
  useUserPermissions: () => ({ allowPermissions: () => true }),
}));

const { ProjectsBaseHeader } = await import("@/components/project/header");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("uses administrative channel copy for the ordinary project toolbar", async () => {
  const openOrganizationModal = vi.fn();
  window.addEventListener("administrative-organization-create", openOrganizationModal);
  await act(async () => root.render(<ProjectsBaseHeader />));

  expect(container.textContent).toContain("administrative.projects.title");
  const buttons = Array.from(container.querySelectorAll("button")).map((button) => button.textContent);
  expect(buttons).toContain("新建组织");
  expect(buttons.some((label) => label?.includes("administrative.projects.create"))).toBe(true);

  await act(async () => {
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "新建组织")
      ?.click();
  });
  expect(openOrganizationModal).toHaveBeenCalledOnce();
  window.removeEventListener("administrative-organization-create", openOrganizationModal);
});

it("keeps the administrative toolbar when research is disabled", async () => {
  mocks.research.isIaV2Enabled = false;
  await act(async () => root.render(<ProjectsBaseHeader />));
  mocks.research.isIaV2Enabled = true;

  expect(container.textContent).toContain("administrative.projects.title");
  const buttons = Array.from(container.querySelectorAll("button")).map((button) => button.textContent);
  expect(buttons).toContain("新建组织");
  expect(buttons.some((label) => label?.includes("administrative.projects.create"))).toBe(true);
});
