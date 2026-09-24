import type { TResearchChain, TResearchChainNode } from "@plane/types";

/**
 * Priority used when picking the node that represents the researcher's
 * current position. Attention-seeking states win over ordinary progress.
 */
export const RESEARCH_NODE_STATUS_PRIORITY: Record<TResearchChainNode["status"], number> = {
  WAITING_HUMAN: 0,
  NEEDS_REVISION: 1,
  FAILED: 2,
  ACTIVE: 3,
  DRAFT: 4,
  COMPLETED: 5,
  ARCHIVED: 6,
};

/** Compare two nodes by status priority and then by most recent update. */
function compareNodes(left: TResearchChainNode, right: TResearchChainNode) {
  return (
    RESEARCH_NODE_STATUS_PRIORITY[left.status] - RESEARCH_NODE_STATUS_PRIORITY[right.status] ||
    new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
  );
}

/**
 * Pick the node that should stay visible as the researcher's current position.
 *
 * Args:
 *   nodes: Business nodes returned by the chain API.
 *
 * Returns:
 *   The most attention-worthy, most recently updated node, or null when empty.
 */
export function pickCurrentNode(nodes: TResearchChainNode[]): TResearchChainNode | null {
  if (!nodes.length) return null;
  // eslint-disable-next-line unicorn/no-array-sort
  return [...nodes].sort(compareNodes)[0] ?? null;
}

/**
 * Pick the chain that represents the researcher's current topic.
 *
 * Args:
 *   chains: Chains visible to the current user, in any API order.
 *
 * Returns:
 *   The most recently updated chain, or null when the user has no visible chain.
 */
export function pickCurrentChain(chains: TResearchChain[]): TResearchChain | null {
  if (!chains.length) return null;
  // eslint-disable-next-line unicorn/no-array-sort
  const sorted = [...chains].sort(
    (left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
  );
  return sorted[0] ?? null;
}
