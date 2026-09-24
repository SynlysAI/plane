// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  research: {
    identityWorkspaceSlug: "lab",
    identity: {},
    isIaV2Enabled: false,
    fetchIdentity: vi.fn(),
  },
  destination: null as string | null,
}));

vi.mock("react-router", () => ({
  useParams: () => ({ workspaceSlug: "lab" }),
  useSearchParams: () => [new URLSearchParams("status=NEEDS_REVISION")],
  useLocation: () => ({ hash: "#history" }),
  Navigate: ({ to }: { to: string }) => {
    mocks.destination = to;
    return <div>redirect</div>;
  },
}));
vi.mock("@plane/ui", () => ({ Spinner: () => <div>spinner</div> }));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks.research }));

const { ResearchIaV2Redirect } = await import("@/components/research/navigation/research-ia-v2-redirect");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.destination = null;
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("keeps the legacy page while IA v2 is disabled", async () => {
  await act(async () =>
    root.render(
      <ResearchIaV2Redirect to="/lab/research/chains" query={{ view: "projects" }}>
        <div>legacy-page</div>
      </ResearchIaV2Redirect>
    )
  );

  expect(container.textContent).toContain("legacy-page");
  expect(mocks.destination).toBeNull();
});

it("redirects with destination query, legacy query, and hash when IA v2 is enabled", async () => {
  mocks.research.isIaV2Enabled = true;
  await act(async () =>
    root.render(
      <ResearchIaV2Redirect to="/lab/research/chains" query={{ view: "projects" }}>
        <div>legacy-page</div>
      </ResearchIaV2Redirect>
    )
  );

  expect(mocks.destination).toBe("/lab/research/chains?status=NEEDS_REVISION&view=projects#history");
  expect(container.textContent).not.toContain("legacy-page");
});
