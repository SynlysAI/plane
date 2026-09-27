import type { TResearchChain, TResearchChainNode } from "@plane/types";
import {
  pickCurrentChain,
  pickCurrentNode,
  RESEARCH_NODE_STATUS_PRIORITY,
} from "@/components/research/chains/research-selection";
import { expect, it } from "vitest";

/** Create a typed chain fixture with the invariant defaults from the API contract. */
function chain(seed: Partial<TResearchChain> & { id: string; updated_at: string }): TResearchChain {
  return {
    schema_version: "research-chain.v1",
    project: "课题",
    workspace: "ws",
    owner: "user-1",
    status: "ACTIVE",
    visibility: "PRIVATE",
    created_at: "2026-09-20T00:00:00Z",
    ...seed,
  };
}

/** Create a typed chain-node fixture with the invariant defaults from the API contract. */
function node(
  seed: Partial<TResearchChainNode> & { id: string; status: TResearchChainNode["status"]; updated_at: string }
): TResearchChainNode {
  return {
    schema_version: "research-node.v1",
    chain: "chain-1",
    node_type: "RESEARCH",
    title: "节点",
    parent_node: null,
    loop_iteration: 0,
    assignee: "user-1",
    created_at: "2026-09-20T00:00:00Z",
    ...seed,
  };
}

it("picks the most recently updated chain regardless of API order", () => {
  const older = chain({ id: "chain-old", updated_at: "2026-09-20T00:00:00Z" });
  const newer = chain({ id: "chain-new", updated_at: "2026-09-24T00:00:00Z" });

  expect(pickCurrentChain([older, newer])?.id).toBe("chain-new");
  expect(pickCurrentChain([newer, older])?.id).toBe("chain-new");
  expect(pickCurrentChain([])).toBeNull();
});

it("picks the current node by attention priority and then freshness", () => {
  const active = node({ id: "active", status: "ACTIVE", updated_at: "2026-09-24T00:00:00Z" });
  const waiting = node({ id: "waiting", status: "WAITING_HUMAN", updated_at: "2026-09-22T00:00:00Z" });
  const archived = node({ id: "archived", status: "ARCHIVED", updated_at: "2026-09-24T00:00:00Z" });

  expect(pickCurrentNode([active, waiting, archived])?.id).toBe("waiting");
  expect(pickCurrentNode([archived, active])?.id).toBe("active");
  expect(pickCurrentNode([])).toBeNull();
  expect(RESEARCH_NODE_STATUS_PRIORITY.WAITING_HUMAN).toBeLessThan(RESEARCH_NODE_STATUS_PRIORITY.ACTIVE);
});

it("keeps the overview header and home summary on the same current chain", () => {
  const chains = [
    chain({ id: "chain-a", updated_at: "2026-09-21T00:00:00Z" }),
    chain({ id: "chain-b", updated_at: "2026-09-23T00:00:00Z" }),
    chain({ id: "chain-c", updated_at: "2026-09-22T00:00:00Z" }),
  ];

  const reordered = [chains[2], chains[1], chains[0]];
  expect(pickCurrentChain(chains)?.id).toEqual(pickCurrentChain(reordered)?.id);
});
