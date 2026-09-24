// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";
import type { TResearchChainNode } from "@plane/types";

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const value = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      return typeof value === "string" ? value : key;
    },
  }),
}));

const { ResearchChainWorkflowRail } = await import("@/components/research/chains/research-chain-workflow-rail");

/** Create a typed chain-node fixture with the invariant defaults from the API contract. */
function node(
  seed: Partial<TResearchChainNode> & { id: string; node_type: string; title: string }
): TResearchChainNode {
  return {
    schema_version: "research-node.v1",
    chain: "chain-1",
    parent_node: null,
    loop_iteration: 0,
    status: "DRAFT",
    assignee: "user-1",
    created_at: "2026-09-23T01:00:00Z",
    updated_at: "2026-09-23T01:00:00Z",
    ...seed,
  };
}

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

it("renders archived stages with a muted archived style instead of a future style", async () => {
  const archived = node({ id: "summary", node_type: "SUMMARY", title: "总结", status: "ARCHIVED" });
  await act(async () => {
    root.render(
      <ResearchChainWorkflowRail
        nodes={[archived]}
        currentNodeId={null}
        selectedNodeId={null}
        onSelect={() => undefined}
      />
    );
  });
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('[role="listitem"] button')];
  const archivedButton = buttons.find((button) => button.textContent?.includes("总结"));
  const upcomingButton = buttons.find((button) => button.textContent?.includes("文献调研"));
  expect(archivedButton?.className).toContain("opacity-70");
  expect(archivedButton?.textContent).toContain("已归档");
  expect(upcomingButton?.className).not.toContain("opacity-70");
});

it("keeps the shared marker readable inside shared stage buttons", async () => {
  const topic = node({ id: "topic", node_type: "TOPIC_EVALUATION", title: "选题评估", status: "WAITING_HUMAN" });
  await act(async () => {
    root.render(
      <ResearchChainWorkflowRail
        nodes={[topic]}
        currentNodeId={topic.id}
        selectedNodeId={null}
        onSelect={() => undefined}
      />
    );
  });
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('[role="listitem"] button')];
  const selectionButton = buttons.find((button) => button.textContent?.includes("选题"));
  expect(selectionButton?.textContent).toContain("共享节点");
});

it("explains why a stage without nodes is disabled", async () => {
  await act(async () => {
    root.render(
      <ResearchChainWorkflowRail nodes={[]} currentNodeId={null} selectedNodeId={null} onSelect={() => undefined} />
    );
  });
  const disabled = container.querySelector<HTMLButtonElement>("button:disabled");
  expect(disabled?.getAttribute("title")).toContain("该阶段尚未产生实际节点");
});
