// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { observable, runInAction } from "mobx";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TNavigationTree } from "@/services/research/navigation.service";

const mocks = vi.hoisted(() => ({
  projectMap: {} as Record<string, { id: string; name: string; identifier: string }>,
  researchProjects: {} as Record<string, { id: string }>,
  tree: null as TNavigationTree | null,
  getTree: vi.fn(),
  getAdministrativeOrganizations: vi.fn(),
}));

/** 渲染导航树测试使用的最小图标替身。 */
function NavigationIcon() {
  return <span aria-hidden="true" />;
}

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "lab" }),
  usePathname: () => "/lab/projects",
}));

vi.mock("@makeplane/propel/icons", () => {
  return { AddOutline: NavigationIcon, ChevronRightOutline: NavigationIcon, MoreHorizontalOutline: NavigationIcon };
});

vi.mock("@plane/propel/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  IconButton: ({
    children,
    icon: _icon,
    iconClassName: _iconClassName,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: unknown; iconClassName?: string }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { SUCCESS: "success", ERROR: "error" },
  setToast: vi.fn(),
}));

vi.mock("@plane/ui", () => {
  type CustomMenuProps = React.HTMLAttributes<HTMLDivElement> & {
    customButton?: React.ReactNode;
  };
  const CustomMenu = Object.assign(
    ({ children, customButton, ...props }: CustomMenuProps) => (
      <div {...props}>
        {customButton}
        {children}
      </div>
    ),
    {
      MenuItem: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...props} />,
    }
  );
  return {
    CustomMenu,
    EModalWidth: { SM: "sm" },
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
    ModalCore: ({ children, isOpen }: { children: React.ReactNode; isOpen: boolean }) =>
      isOpen ? <div>{children}</div> : null,
  };
});

vi.mock("@plane/utils", () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(" "),
}));

vi.mock("@/components/sidebar/sidebar-navigation", () => ({
  SidebarNavItem: ({
    children,
    isActive: _isActive,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { isActive?: boolean }) => <div {...props}>{children}</div>,
}));

vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({ projectMap: mocks.projectMap }),
}));

vi.mock("@/hooks/store/use-research", () => ({
  useResearch: () => ({ researchProjects: mocks.researchProjects }),
}));

vi.mock("@/services/research/navigation.service", () => ({
  ResearchNavigationService: class {
    getTree = mocks.getTree;
    getAdministrativeOrganizations = mocks.getAdministrativeOrganizations;
  },
}));

const { ResearchProjectTree } = await import("@/components/research/navigation/research-project-tree");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function TreeHarness() {
  return (
    <>
      <ResearchProjectTree scope="ADMINISTRATIVE" title="行政项目" href="/lab/projects" canManage={false} />
      <button
        type="button"
        onClick={() => {
          runInAction(() => {
            mocks.projectMap["project-2"] = { id: "project-2", name: "test2", identifier: "TEST2" };
          });
        }}
      >
        创建项目
      </button>
    </>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.projectMap = observable({
    "project-1": { id: "project-1", name: "test1", identifier: "TEST1" },
  });
  mocks.researchProjects = observable({});
  mocks.getAdministrativeOrganizations.mockReset().mockImplementation(async () => [
    {
      id: "public-id",
      name: "公共",
      is_default: true,
      can_manage: false,
      project_ids: Object.keys(mocks.projectMap),
      members: [],
    },
  ]);
  mocks.tree = {
    scope: "ADMINISTRATIVE",
    can_manage: false,
    categories: [],
    uncategorized: [{ id: "project-1", name: "test1", identifier: "TEST1", kind: "ADMINISTRATIVE" }],
  };
  mocks.getTree.mockReset().mockImplementation(async () => mocks.tree);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("refreshes the administrative tree when a created project enters the project store", async () => {
  await act(async () => root.render(<TreeHarness />));
  await act(async () => undefined);
  expect(mocks.getTree).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("test1");

  mocks.tree = {
    scope: "ADMINISTRATIVE",
    can_manage: false,
    categories: [],
    uncategorized: [
      { id: "project-1", name: "test1", identifier: "TEST1", kind: "ADMINISTRATIVE" },
      { id: "project-2", name: "test2", identifier: "TEST2", kind: "ADMINISTRATIVE" },
    ],
  };
  const createButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "创建项目");
  await act(async () => createButton?.click());
  await act(async () => undefined);
  await act(async () => undefined);

  expect(mocks.getTree).toHaveBeenCalledTimes(2);
  expect(mocks.getTree).toHaveBeenLastCalledWith("lab", "ADMINISTRATIVE");
  expect(container.textContent).toContain("test2");
});

it("labels the default administrative organization as public without member management", async () => {
  await act(async () => root.render(<TreeHarness />));
  await act(async () => undefined);

  expect(container.textContent).toContain("公共");
  expect(container.textContent).not.toContain("成员管理");
});

it("indents public organization projects inside the hierarchy container", async () => {
  mocks.getAdministrativeOrganizations.mockReset().mockImplementation(async () => [
    {
      id: "public-id",
      name: "公共",
      is_default: true,
      can_manage: false,
      project_ids: ["project-1"],
      members: [],
    },
    {
      id: "office-id",
      name: "行政办公室",
      is_default: false,
      can_manage: false,
      project_ids: ["project-1"],
      members: [],
    },
  ]);
  await act(async () => root.render(<TreeHarness />));
  await act(async () => undefined);

  const group = container.querySelector('[role="group"][aria-label="公共"]');
  const namedGroup = container.querySelector('[role="group"][aria-label="行政办公室"]');
  expect(group).not.toBeNull();
  expect(namedGroup).not.toBeNull();
  expect(group?.className).toBe(namedGroup?.className);
  expect(group?.className).toContain("ml-3");
  expect(group?.className).toContain("border-l");
  expect(group?.textContent).toContain("test1");
});

it.each([
  { name: "行政办公室", hasProjects: true },
  { name: "公共", hasProjects: true },
  { name: "行政办公室", hasProjects: false },
  { name: "公共", hasProjects: false },
])("toggles $name independently and restores its state (has projects: $hasProjects)", async ({ name, hasProjects }) => {
  mocks.getAdministrativeOrganizations.mockResolvedValue([
    {
      id: "public-id",
      name: "公共",
      is_default: true,
      can_manage: false,
      project_ids: hasProjects ? ["project-1"] : [],
      members: [],
    },
    {
      id: "office-id",
      name: "行政办公室",
      is_default: false,
      can_manage: false,
      project_ids: hasProjects ? ["project-1"] : [],
      members: [],
    },
  ]);
  await act(async () => root.render(<TreeHarness />));

  const otherName = name === "公共" ? "行政办公室" : "公共";
  const toggle = container.querySelector<HTMLButtonElement>(`button[aria-label="收起${name}"]`);
  expect(toggle).not.toBeNull();
  expect(toggle?.getAttribute("aria-expanded")).toBe("true");

  await act(async () => toggle?.click());

  expect(toggle?.getAttribute("aria-label")).toBe(`展开${name}`);
  expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector(`[role="group"][aria-label="${name}"]`)).toBeNull();
  expect(container.querySelector(`[role="group"][aria-label="${otherName}"]`)).not.toBeNull();

  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="收起行政项目"]')?.click());
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="展开行政项目"]')?.click());
  expect(container.querySelector(`button[aria-label="展开${name}"]`)).not.toBeNull();

  await act(async () => root.render(null));
  await act(async () => root.render(<TreeHarness />));
  expect(container.querySelector(`button[aria-label="展开${name}"]`)).not.toBeNull();
  expect(container.querySelector(`[role="group"][aria-label="${otherName}"]`)).not.toBeNull();

  await act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label="展开${name}"]`)?.click());
  const group = container.querySelector(`[role="group"][aria-label="${name}"]`);
  expect(group).not.toBeNull();
  expect(group?.querySelectorAll("a").length).toBe(hasProjects ? 1 : 0);
});
