import { describe, expect, it, vi } from "vitest";
import { createEditorUpdateHandler } from "../../../../packages/editor/src/helpers/editor-update-handler";

/** 构造带文档变更标记的最小 Tiptap 更新事务。 */
function transaction(docChanged: boolean, isMigrationUpdate = false) {
  return {
    docChanged,
    getMeta: (key: string) => (key === "uniqueIdOnlyChange" ? isMigrationUpdate : undefined),
  };
}

describe("createEditorUpdateHandler", () => {
  it("ignores selection-only transactions but emits document changes", () => {
    const onChange = vi.fn();
    const handler = createEditorUpdateHandler(onChange);
    const editor = { getJSON: () => ({ type: "doc" }), getHTML: () => "<p>weekly report</p>" };

    handler({ editor, transaction: transaction(false) });
    expect(onChange).not.toHaveBeenCalled();

    handler({ editor, transaction: transaction(true) });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ type: "doc" }, "<p>weekly report</p>", {
      isMigrationUpdate: false,
    });
  });

  it("marks migration-only document updates for controlled editors", () => {
    const onChange = vi.fn();
    const editor = { getJSON: () => ({ type: "doc" }), getHTML: () => "<p>weekly report</p>" };

    createEditorUpdateHandler(onChange)({ editor, transaction: transaction(true, true) });

    expect(onChange).toHaveBeenCalledWith({ type: "doc" }, "<p>weekly report</p>", {
      isMigrationUpdate: true,
    });
  });
});
