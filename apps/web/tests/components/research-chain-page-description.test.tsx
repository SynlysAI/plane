// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useParams: () => ({ workspaceSlug: "lab" }) };
});
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => ({}) }));
vi.mock("@/components/core/page-title", () => ({ PageHead: () => null }));
vi.mock("@/components/research/common/research-page-shell", () => ({
  ResearchPageShell: ({ descriptionKey, children }: { descriptionKey?: string; children: React.ReactNode }) => (
    <main>
      <output>{descriptionKey}</output>
      {children}
    </main>
  ),
}));
vi.mock("@/components/research/chains/research-chain-workbench", () => ({
  ResearchChainWorkbench: () => <div>workbench</div>,
}));

const { default: ResearchChainsPage } = await import("../../app/(all)/[workspaceSlug]/(projects)/research/chains/page");

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

it("项目档案视图使用档案索引说明，课题视图保留默认说明", async () => {
  await act(async () =>
    root.render(
      <MemoryRouter key="projects" initialEntries={["/lab/research/chains?view=projects"]}>
        <ResearchChainsPage />
      </MemoryRouter>
    )
  );
  expect(container.querySelector("output")?.textContent).toBe("research.chains.project_records_description");

  await act(async () =>
    root.render(
      <MemoryRouter key="chains" initialEntries={["/lab/research/chains"]}>
        <ResearchChainsPage />
      </MemoryRouter>
    )
  );
  expect(container.querySelector("output")?.textContent).toBe("research.chains.description");
});
