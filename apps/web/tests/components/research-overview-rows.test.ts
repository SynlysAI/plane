import { expect, it } from "vitest";
import type { TResearchIdentity } from "@plane/types";
import { chainOwnerLabel, selectResearchOverviewChains } from "@/components/research/common/research-overview-rows";

const chains = Array.from({ length: 6 }, (_, index) => ({
  id: `chain-${index + 1}`,
  owner: "student-1",
  owner_name: "学生甲",
}));

/**
 * 用给定角色拼一份最小身份。
 */
function identity(
  partial: Partial<TResearchIdentity> & { user?: Partial<TResearchIdentity["user"]> }
): TResearchIdentity {
  return partial as TResearchIdentity;
}

it("stacks at most five rows for a direction owner and keeps the owner name", () => {
  const viewer = identity({
    user: { id: "pi-1", org_units: [{ org_role: "PI", org_unit: "unit", org_unit_name: "方向", is_primary: true }] },
  });
  const selected = selectResearchOverviewChains(viewer, chains);

  expect(selected.mode).toBe("stacked");
  expect(selected.rows).toHaveLength(5);
  expect(chainOwnerLabel(viewer, chains[0])).toBe("学生甲");
});

it("uses one row and no name when every chain belongs to the viewer", () => {
  const viewer = identity({
    capabilities: { is_main_pi: true },
    user: { id: "student-1", is_main_pi: true, mentee_ids: [], org_units: [] },
  });
  const selected = selectResearchOverviewChains(viewer, chains);

  expect(selected.mode).toBe("single");
  expect(selected.rows).toHaveLength(1);
  expect(chainOwnerLabel(viewer, chains[0])).toBe("");
});
