import { expect, it } from "vitest";

import { DEFAULT_WORK_ITEM_FORM_VALUES } from "../../../../packages/constants/src/issue/modal";

it("uses an empty module list for new work items", () => {
  expect(DEFAULT_WORK_ITEM_FORM_VALUES.module_ids).toEqual([]);
});
