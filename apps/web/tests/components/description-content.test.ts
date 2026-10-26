import { describe, expect, it } from "vitest";

import { isDescriptionContentEmpty } from "../../../../packages/utils/src/string";

describe("isDescriptionContentEmpty", () => {
  it("treats editor media nodes as visible description content", () => {
    expect(isDescriptionContentEmpty('<image-component src="/assets/image/"></image-component>')).toBe(false);
    expect(isDescriptionContentEmpty('<img src="/assets/image/">')).toBe(false);
    expect(isDescriptionContentEmpty("<table><tbody><tr><td></td></tr></tbody></table>")).toBe(false);
  });

  it("keeps truly empty descriptions empty", () => {
    expect(isDescriptionContentEmpty(undefined)).toBe(true);
    expect(isDescriptionContentEmpty("")).toBe(true);
    expect(isDescriptionContentEmpty("<p></p>")).toBe(true);
    expect(isDescriptionContentEmpty("<p>   </p>")).toBe(true);
  });
});
