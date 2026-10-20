// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "lab" }),
}));
vi.mock("@plane/ui", () => ({
  ContentWrapper: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="home-content-wrapper">{children}</div>
  ),
}));
vi.mock("@/hooks/store/user", () => ({
  useUserProfile: () => ({
    data: { is_tour_completed: true },
    updateTourCompleted: vi.fn(),
  }),
}));
vi.mock("@/components/onboarding/tour/root", () => ({
  TourRoot: () => <div data-testid="home-tour" />,
}));
vi.mock("@/components/home/workbench", () => ({
  WorkspaceHomeWorkbench: () => <div data-testid="home-workbench" />,
}));
vi.mock("@/components/issues/peek-overview/peek-overviews", () => ({
  HomePeekOverviewsRoot: () => <div data-testid="home-issue-peek" />,
}));

const { WorkspaceHomeView } = await import("@/components/home/root");
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

it("renders the issue peek overlay before home workbench content", async () => {
  await act(async () => root.render(<WorkspaceHomeView />));

  const overlay = container.querySelector('[data-testid="home-issue-peek"]');
  const workbench = container.querySelector('[data-testid="home-workbench"]');
  expect(overlay).not.toBeNull();
  expect(workbench).not.toBeNull();
  expect(overlay!.compareDocumentPosition(workbench!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});
