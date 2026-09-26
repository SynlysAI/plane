// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";
import type { TResearchChain } from "@plane/types";

const mocks = vi.hoisted(() => ({
  research: {
    identity: { sections: {} },
    canSee: (key: string) => key === "research_chain",
  },
  getChains: vi.fn(),
  getConnections: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
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
    currentLocale: "zh-CN",
  }),
}));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks.research }));
vi.mock("@/services/research/chain.service", () => ({
  ResearchChainService: class {
    getChains = mocks.getChains;
  },
}));
vi.mock("@/services/research/integration.service", () => ({
  ResearchIntegrationService: class {
    getConnections = mocks.getConnections;
  },
}));

const { ResearchChainPortal } = await import("@/components/research/chains/research-chain-portal");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function chain(id: string, name: string): TResearchChain {
  return {
    schema_version: "research-chain.v1",
    id,
    project: name,
    workspace: "lab",
    owner: "user-1",
    status: "ACTIVE",
    visibility: "PRIVATE",
    created_at: "2026-09-20T00:00:00Z",
    updated_at: "2026-09-23T00:00:00Z",
  } as TResearchChain;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.getConnections.mockResolvedValue({ results: [] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("switches the portal chain instead of always opening the first chain", async () => {
  mocks.getChains.mockResolvedValue([chain("chain-1", "石墨负极课题"), chain("chain-2", "硅碳负极课题")]);
  await act(async () => root.render(<ResearchChainPortal workspaceSlug="lab" />));

  expect(container.textContent).toContain("石墨负极课题");
  expect(container.querySelector('a[href="/lab/research/chains/chain-1"]')).not.toBeNull();

  const next = container.querySelector<HTMLButtonElement>('button[aria-label="下一个课题"]');
  expect(next).not.toBeNull();
  await act(async () => next?.click());

  expect(container.textContent).toContain("硅碳负极课题");
  expect(container.querySelector('a[href="/lab/research/chains/chain-2"]')).not.toBeNull();
  expect(container.textContent).toContain("第 2 / 2 个课题");
});

it("does not show a switcher for one visible chain", async () => {
  mocks.getChains.mockResolvedValue([chain("only", "唯一课题")]);
  await act(async () => root.render(<ResearchChainPortal workspaceSlug="lab" />));
  expect(container.querySelector('button[aria-label="下一个课题"]')).toBeNull();
  expect(container.querySelector('a[href="/lab/research/chains/only"]')).not.toBeNull();
});
