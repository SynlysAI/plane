// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  research: {
    identityWorkspaceSlug: "lab",
    identity: {},
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
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks.research }));

const { LegacyResearchRedirect } = await import("@/components/research/navigation/legacy-research-redirect");

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

it("always resolves legacy routes into the current layout", async () => {
  await act(async () => root.render(<LegacyResearchRedirect to="/lab/research/chains" query={{ view: "projects" }} />));

  expect(mocks.destination).not.toBeNull();
});

it("redirects with destination query, legacy query, and hash preserved", async () => {
  await act(async () => root.render(<LegacyResearchRedirect to="/lab/research/chains" query={{ view: "projects" }} />));

  expect(mocks.destination).toBe("/lab/research/chains?status=NEEDS_REVISION&view=projects#history");
});
