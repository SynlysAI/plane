// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ enter: undefined as (() => void) | undefined }));
vi.mock("@plane/editor", () => ({
  LiteTextEditorWithRef: React.forwardRef(function Editor(props: { onEnterKeyPress: () => void }, _ref) {
    // 模拟 TipTap：快捷键扩展只在第一次初始化时捕获回调。
    if (!captured.enter) captured.enter = props.onEnterKeyPress;
    return null;
  }),
}));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/editor/embeds/mentions", () => ({ EditorMentionsRoot: () => null }));
vi.mock("@/components/editor/lite-text/toolbar", () => ({ IssueCommentToolbar: () => null }));
vi.mock("@/hooks/editor", () => ({
  useEditorMention: () => ({ fetchMentions: vi.fn() }),
  useEditorConfig: () => ({ getEditorFileHandlers: vi.fn() }),
}));
vi.mock("@/hooks/store/use-member", () => ({ useMember: () => ({ getUserDetails: vi.fn() }) }));
vi.mock("@/hooks/use-parse-editor-content", () => ({ useParseEditorContent: () => ({ getEditorMetaData: vi.fn() }) }));
vi.mock("@/hooks/use-editor-flagging", () => ({
  useEditorFlagging: () => ({ liteText: { disabled: [], flagged: [] } }),
}));
vi.mock("@/services/workspace.service", () => ({ WorkspaceService: vi.fn() }));
vi.mock("@/components/editor/lite-text/lite-toolbar", () => ({ LiteToolbar: () => null }));
const { LiteTextEditor } = await import("@/components/editor/lite-text/editor");
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  await act(async () => root.unmount());
  captured.enter = undefined;
});

it("uses the newest submit validation even when the editor retains its initial Enter shortcut", async () => {
  root = createRoot(document.createElement("div"));
  const original = vi.fn();
  const current = vi.fn();
  const props = {
    editable: true as const,
    workspaceId: "ws",
    workspaceSlug: "lab",
    id: "draft",
    initialValue: "<p></p>",
    value: null,
    uploadFile: vi.fn(),
    duplicateFile: vi.fn(),
  };
  await act(async () => root.render(<LiteTextEditor {...props} onEnterKeyPress={original} />));
  const initialShortcut = captured.enter;
  await act(async () => root.render(<LiteTextEditor {...props} hasAttachments onEnterKeyPress={current} />));
  await act(async () => initialShortcut?.());
  expect(original).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledOnce();
});
