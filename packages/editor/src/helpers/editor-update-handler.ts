import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import type { TEditorHookProps } from "../types/hook";

type TEditorOnChange = TEditorHookProps["onChange"];
type TEditorUpdatePayload = {
  editor: Pick<Editor, "getJSON" | "getHTML">;
  transaction: Pick<Transaction, "docChanged" | "getMeta">;
};

/** Create an update handler that emits only document-changing editor updates. */
export function createEditorUpdateHandler(onChange?: TEditorOnChange) {
  return ({ editor, transaction }: TEditorUpdatePayload) => {
    // Selection and focus transactions do not change document content, so
    // controlled editors must not treat them as user edits while saving.
    if (!transaction.docChanged) return;

    const isMigrationUpdate = transaction.getMeta("uniqueIdOnlyChange") === true;
    onChange?.(editor.getJSON(), editor.getHTML(), { isMigrationUpdate });
  };
}
