// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insertRichImageFiles: vi.fn(() => true),
  insertLiteImageFiles: vi.fn(() => true),
}));

vi.mock("@plane/editor", () => ({
  RichTextEditorWithRef: React.forwardRef(function RichTextEditorWithRef(
    _props: Record<string, unknown>,
    ref: React.ForwardedRef<unknown>
  ) {
    React.useImperativeHandle(ref, () => ({ insertImageFiles: mocks.insertRichImageFiles }));
    return <div data-testid="rich-editor-content" />;
  }),
  LiteTextEditorWithRef: React.forwardRef(function LiteTextEditorWithRef(
    props: Record<string, unknown>,
    ref: React.ForwardedRef<unknown>
  ) {
    React.useImperativeHandle(ref, () => ({ insertImageFiles: mocks.insertLiteImageFiles }));
    return <div data-testid="lite-editor-content" className={String(props.containerClassName ?? "")} />;
  }),
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@plane/utils", () => ({
  cn: (...classes: Array<string | false | null | undefined | Record<string, boolean>>) =>
    classes
      .flatMap((item) => {
        if (typeof item === "string") return [item];
        if (item && typeof item === "object") {
          return Object.entries(item)
            .filter(([, enabled]) => enabled)
            .map(([className]) => className);
        }
        return [];
      })
      .join(" "),
  isCommentEmpty: () => false,
}));
vi.mock("@/components/editor/embeds/mentions", () => ({ EditorMentionsRoot: () => null }));
vi.mock("@/components/editor/lite-text/toolbar", () => ({ IssueCommentToolbar: () => null }));
vi.mock("@/components/editor/lite-text/lite-toolbar", () => ({ LiteToolbar: () => null }));
vi.mock("@/hooks/editor", () => ({
  useEditorConfig: () => ({ getEditorFileHandlers: () => ({}) }),
  useEditorMention: () => ({ fetchMentions: vi.fn() }),
}));
vi.mock("@/hooks/store/use-member", () => ({ useMember: () => ({ getUserDetails: vi.fn() }) }));
vi.mock("@/hooks/use-parse-editor-content", () => ({
  useParseEditorContent: () => ({ getEditorMetaData: vi.fn() }),
}));
vi.mock("@/hooks/use-editor-flagging", () => ({
  useEditorFlagging: () => ({
    richText: { disabled: [], flagged: [] },
    liteText: { disabled: [], flagged: [] },
  }),
}));
vi.mock("@/services/workspace.service", () => ({ WorkspaceService: vi.fn() }));

const { useEditorAttachmentDrop } = await import("@/components/editor/use-editor-attachment-drop");
const { RichTextEditor } = await import("@/components/editor/rich-text/editor");
const { LiteTextEditor } = await import("@/components/editor/lite-text/editor");

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });

type FakeFileEntry = {
  isFile: true;
  fullPath: string;
  file: (callback: (file: File) => void) => void;
};

type FakeDirectoryEntry = {
  isFile: false;
  isDirectory: true;
  fullPath: string;
  createReader: () => {
    readEntries: (callback: (entries: Array<FakeFileEntry | FakeDirectoryEntry>) => void) => void;
  };
};

function fileEntry(fullPath: string, file: File): FakeFileEntry {
  return { isFile: true, fullPath, file: (callback) => callback(file) };
}

function directory(fullPath: string, entries: Array<FakeFileEntry | FakeDirectoryEntry>): FakeDirectoryEntry {
  let readCount = 0;
  return {
    isFile: false,
    isDirectory: true,
    fullPath,
    createReader: () => ({
      readEntries: (callback) => {
        readCount += 1;
        callback(readCount === 1 ? entries : []);
      },
    }),
  };
}

function transferItem(entry: FakeFileEntry | FakeDirectoryEntry, file: File) {
  return { kind: "file", getAsFile: () => file, webkitGetAsEntry: () => entry };
}

/** 构造 file-selector 可展开的原生拖拽数据。 */
function dragData(items: Array<{ entry: FakeFileEntry | FakeDirectoryEntry; file: File }>) {
  return {
    types: ["Files"],
    files: items.map((item) => item.file),
    items: items.map((item) => transferItem(item.entry, item.file)),
    dropEffect: "none",
  };
}

/** 在指定表面释放文件或文件夹。 */
async function drop(
  target: Element,
  items: Array<{ entry: FakeFileEntry | FakeDirectoryEntry; file: File }>,
  options: { alreadyHandled?: boolean } = {}
) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dragData(items) });
  if (options.alreadyHandled) event.preventDefault();
  await act(async () => {
    target.dispatchEvent(event);
  });
  await act(async () => await Promise.resolve());
  return event;
}

function DragHarness({ onFiles }: { onFiles: (files: File[]) => void }) {
  const { isAttachmentDragActive, attachmentDragHandlers } = useEditorAttachmentDrop({ onFiles });
  return (
    <div data-active={String(isAttachmentDragActive)} data-testid="drop-surface" {...attachmentDragHandlers}>
      <span data-testid="content" />
    </div>
  );
}

let container: HTMLDivElement;
let root: Root;

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

it("accepts a folder dropped on the outer surface and flattens nested files", async () => {
  const onFiles = vi.fn();
  await act(async () => root.render(<DragHarness onFiles={onFiles} />));
  const image = new File(["image"], "figure.png", { type: "image/png" });
  const pdf = new File(["pdf"], "report.pdf", { type: "application/pdf" });
  const nested = directory("/packet/nested", [fileEntry("/packet/nested/report.pdf", pdf)]);
  const packet = directory("/packet", [fileEntry("/packet/figure.png", image), nested]);

  await drop(container.firstElementChild!, [{ entry: packet, file: new File([], "packet", { type: "" }) }]);

  expect(onFiles).toHaveBeenCalledTimes(1);
  expect(onFiles.mock.calls[0][0].map((file: File) => file.name)).toEqual(["figure.png", "report.pdf"]);
});

it("marks copy semantics and ignores a drop already handled by ProseMirror", async () => {
  const onFiles = vi.fn();
  await act(async () => root.render(<DragHarness onFiles={onFiles} />));
  const surface = container.firstElementChild!;
  const pdf = new File(["pdf"], "report.pdf", { type: "application/pdf" });
  const entry = fileEntry("/report.pdf", pdf);
  const dragOverData = dragData([{ entry, file: pdf }]);
  const dragOver = new Event("dragover", { bubbles: true, cancelable: true });
  Object.defineProperty(dragOver, "dataTransfer", { value: dragOverData });

  await act(async () => surface.dispatchEvent(dragOver));
  expect(surface.getAttribute("data-active")).toBe("true");
  expect(dragOverData.dropEffect).toBe("copy");

  const event = await drop(surface, [{ entry, file: pdf }], { alreadyHandled: true });
  expect(event.defaultPrevented).toBe(true);
  expect(onFiles).not.toHaveBeenCalled();
});

it("routes outer Rich editor drops to inline images or work-item attachments", async () => {
  const onAttachFiles = vi.fn();
  await act(async () =>
    root.render(
      <RichTextEditor
        editable
        workspaceSlug="lab"
        workspaceId="workspace"
        projectId="project"
        searchMentionCallback={async () => ({})}
        uploadFile={async () => "image"}
        duplicateFile={async () => "image"}
        onAttachFiles={onAttachFiles}
      />
    )
  );
  const surface = container.firstElementChild as HTMLElement;
  const image = new File(["image"], "figure.png", { type: "image/png" });
  const pdf = new File(["pdf"], "report.pdf", { type: "application/pdf" });

  await drop(surface, [{ entry: fileEntry("/figure.png", image), file: image }]);
  expect(mocks.insertRichImageFiles).toHaveBeenCalledWith([image]);
  expect(onAttachFiles).not.toHaveBeenCalled();

  await drop(surface, [{ entry: fileEntry("/report.pdf", pdf), file: pdf }]);
  expect(onAttachFiles).toHaveBeenCalledWith([pdf]);
});

it("gives editable Lite comment editors a stable minimum drop surface", async () => {
  await act(async () =>
    root.render(
      <LiteTextEditor
        editable
        workspaceSlug="lab"
        workspaceId="workspace"
        projectId="project"
        initialValue="<p></p>"
        value={null}
        uploadFile={async () => "image"}
        duplicateFile={async () => "image"}
        onAttachFiles={vi.fn()}
      />
    )
  );

  const editorContent = container.querySelector<HTMLElement>('[data-testid="lite-editor-content"]');
  expect(editorContent?.className).toContain("min-h-[72px]");
  expect(container.firstElementChild?.className).toContain("relative");
});
