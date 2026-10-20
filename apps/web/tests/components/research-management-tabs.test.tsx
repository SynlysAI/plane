// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const research = vi.hoisted(() => ({
  identityWorkspaceSlug: "public",
  identity: {
    user: { is_main_pi: true, is_system_admin: false },
    sections: { org: true },
  },
  isResearchAdmin: false,
  canSee: () => false,
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@plane/constants", () => ({ RESEARCH_SETTINGS_NAVIGATION_ITEMS: [] }));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => ({ "research.nav.management": "科研管理", "research.nav.feedback": "反馈管理" })[key] ?? key,
  }),
}));
vi.mock("@plane/propel/tab-navigation", () => ({
  TabNavigationList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/research/common/research-tab-link", () => ({
  ResearchTabLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => research }));

const { ResearchManagementTabs } = await import("@/components/research/navigation/research-management-tabs");

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
});

it("将反馈入口指向工作区管理页签", async () => {
  await act(async () => root.render(<ResearchManagementTabs currentKey="feedback" />));

  expect(container.querySelector('a[href="/public/management?tab=feedback"]')?.textContent).toBe("反馈管理");
  expect(container.querySelector('a[href="/public/research/settings/feedback"]')).toBeNull();
});
