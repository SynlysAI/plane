import { describe, expect, it } from "vitest";

import { getComputedDisplayProperties } from "@plane/utils";

describe("work item display property defaults", () => {
  it("hides identifiers unless they are explicitly enabled", () => {
    expect(getComputedDisplayProperties().key).toBe(false);
    expect(getComputedDisplayProperties({ key: true }).key).toBe(true);
    expect(getComputedDisplayProperties({ key: false }).key).toBe(false);
  });
});
