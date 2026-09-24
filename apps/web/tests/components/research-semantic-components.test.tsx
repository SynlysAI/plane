// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const value = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      if (typeof value !== "string") return key;
      return value.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ""));
    },
  }),
}));

const { ResearchStatusBadge, researchStatusVariant } =
  await import("@/components/research/common/research-status-badge");
const { ResearchTabLink } = await import("@/components/research/common/research-tab-link");
const { ResearchListState } = await import("@/components/research/common/research-list-state");

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

it("maps research entity statuses to low-saturation badge variants", () => {
  expect(researchStatusVariant("ACTIVE")).toBe("brand");
  expect(researchStatusVariant("WAITING_HUMAN")).toBe("warning");
  expect(researchStatusVariant("FAILED")).toBe("danger");
  expect(researchStatusVariant("COMPLETED")).toBe("success");
  expect(researchStatusVariant("ARCHIVED")).toBe("neutral");
  expect(researchStatusVariant("NOT_A_STATUS")).toBe("neutral");
  expect(researchStatusVariant(null)).toBe("neutral");
});

it("renders the same status shape in list and detail contexts", async () => {
  await act(async () =>
    root.render(
      <>
        <ResearchStatusBadge status="WAITING_HUMAN" size="sm">
          等待人工确认
        </ResearchStatusBadge>
        <ResearchStatusBadge status="WAITING_HUMAN">等待人工确认</ResearchStatusBadge>
      </>
    )
  );
  const badges = [...container.querySelectorAll("span")];
  expect(badges).toHaveLength(2);
  expect(badges.every((badge) => badge.textContent === "等待人工确认")).toBe(true);
});

it("keeps aria-current only on the active tab link", async () => {
  await act(async () =>
    root.render(
      <>
        <ResearchTabLink href="/lab/research/chains?tab=nodes" isActive={true}>
          节点
        </ResearchTabLink>
        <ResearchTabLink href="/lab/research/chains?tab=members" isActive={false}>
          成员
        </ResearchTabLink>
      </>
    )
  );
  const active = container.querySelector('a[aria-current="page"]');
  const inactive = container.querySelector('a[href="/lab/research/chains?tab=members"]');
  expect(active?.textContent).toBe("节点");
  expect(inactive?.getAttribute("aria-current")).toBeNull();
});

it("supports generic empty state config for lists outside the built-in resources", async () => {
  await act(async () =>
    root.render(
      <ResearchListState
        kind="empty"
        resource="reports"
        config={{
          titleKey: "research.list_state.projects.empty.title",
          descriptionKey: "research.list_state.projects.empty.description",
        }}
      />
    )
  );
  expect(container.textContent).toContain("还没有科研项目");
});
