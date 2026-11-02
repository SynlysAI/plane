// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../packages/editor/src/constants/config", () => ({
  ACCEPTED_ATTACHMENT_MIME_TYPES: ["application/pdf"],
  ACCEPTED_IMAGE_MIME_TYPES: ["image/png"],
}));
vi.mock("../../../../packages/editor/src/helpers/file", () => ({
  isFileValid: () => true,
}));
vi.mock("../../../../packages/editor/src/helpers/insert-empty-paragraph-at-node-boundary", () => ({
  insertEmptyParagraphAtNodeBoundaries: () => () => true,
}));
vi.mock("../../../../packages/editor/src/extensions/custom-image/components/node-view", () => ({
  CustomImageNodeView: () => null,
}));

const { DropHandlerPlugin } = await import("../../../../packages/editor/src/plugins/drop");
const { CustomImageExtension } = await import("../../../../packages/editor/src/extensions/custom-image/extension");
const { getImageComponentImageFileMap } = await import("../../../../packages/editor/src/extensions/custom-image/utils");
const { Editor } = await import("../../../../packages/editor/node_modules/@tiptap/core");
const { default: StarterKit } = await import("../../../../packages/editor/node_modules/@tiptap/starter-kit");

type FakeFileEntry = {
  isFile: true;
  isDirectory: false;
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

/** 构造会分批读取并最终结束的目录条目。 */
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

/** 构造文件条目。 */
function fileEntry(fullPath: string, file: File): FakeFileEntry {
  return {
    isFile: true,
    isDirectory: false,
    fullPath,
    file: (callback) => callback(file),
  };
}

/** 读取编辑器中第一个图片节点的 ID。 */
function getFirstImageId(editor: Editor) {
  let imageId: string | null = null;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "imageComponent" && node.attrs.id) {
      imageId = node.attrs.id;
      return false;
    }
    return true;
  });
  return imageId;
}

describe("editor folder drops", () => {
  it("expands item-only folder drops and routes mixed files", async () => {
    const image = new File(["image"], "figure.png", { type: "image/png" });
    const pdf = new File(["pdf"], "protocol.pdf", { type: "application/pdf" });
    const packet = directory("/packet", [
      fileEntry("/packet/figure.png", image),
      directory("/packet/documents", [fileEntry("/packet/documents/protocol.pdf", pdf)]),
    ]);

    const insertImageComponent = vi.fn();
    const attachFiles = vi.fn();
    const editor = {
      isEditable: true,
      state: { selection: { from: 1 }, doc: { content: { size: 2 } } },
      commands: { insertImageComponent },
    };
    const plugin = DropHandlerPlugin({ editor: editor as never, fileHandler: { attachFiles } });
    const preventDefault = vi.fn();
    const folderItem = {
      kind: "file",
      getAsFile: () => new File([], "packet"),
      webkitGetAsEntry: () => packet,
    };
    const event = {
      type: "drop",
      dataTransfer: { files: [], items: [folderItem] },
      clientX: 12,
      clientY: 24,
      preventDefault,
    };
    const view = {
      state: editor.state,
      posAtCoords: vi.fn(() => ({ pos: 1 })),
    };

    const handled = plugin.props.handleDrop?.(view as never, event as never, null as never, false);
    await vi.waitFor(() => expect(attachFiles).toHaveBeenCalledWith([pdf]));

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(insertImageComponent).toHaveBeenCalledWith({ file: image, pos: 1, event: "drop" });
    expect(attachFiles).toHaveBeenCalledWith([pdf]);
  });

  it("does not intercept internal editor moves", () => {
    const attachFiles = vi.fn();
    const editor = {
      isEditable: true,
      state: { selection: { from: 1 }, doc: { content: { size: 2 } } },
      commands: { insertImageComponent: vi.fn() },
    };
    const plugin = DropHandlerPlugin({ editor: editor as never, fileHandler: { attachFiles } });
    const event = {
      dataTransfer: { files: [], items: [{ kind: "file" }] },
      preventDefault: vi.fn(),
    };

    const handled = plugin.props.handleDrop?.({ state: editor.state } as never, event as never, null as never, true);

    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(attachFiles).not.toHaveBeenCalled();
  });
});

describe("editor clipboard file pastes", () => {
  /** 创建可直接执行图片插入命令的最小编辑器。 */
  function createImageEditor() {
    const fileHandler = {
      getAssetSrc: (asset: string) => asset,
      getAssetDownloadSrc: (asset: string) => asset,
      restore: async () => "restored.png",
    };
    return new Editor({
      extensions: [StarterKit, CustomImageExtension({ fileHandler: fileHandler as never, isEditable: true })],
    });
  }

  it("uploads image files from clipboardData.files inline", async () => {
    const image = new File(["image"], "figure.png", { type: "image/png" });
    const insertImageComponent = vi.fn();
    const attachFiles = vi.fn();
    const editor = {
      isEditable: true,
      state: { selection: { from: 1 }, doc: { content: { size: 2 } } },
      commands: { insertImageComponent },
    };
    const plugin = DropHandlerPlugin({ editor: editor as never, fileHandler: { attachFiles } });
    const event = {
      clipboardData: { files: [image], items: [] },
      preventDefault: vi.fn(),
    };

    const handled = plugin.props.handlePaste?.({ state: editor.state } as never, event as never);
    await vi.waitFor(() => expect(insertImageComponent).toHaveBeenCalled());

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(insertImageComponent).toHaveBeenCalledWith({ file: image, pos: 1, event: "paste" });
    expect(attachFiles).not.toHaveBeenCalled();
  });

  it("uploads image files exposed only through clipboardData.items", async () => {
    const image = new File(["image"], "figure.png", { type: "image/png" });
    const insertImageComponent = vi.fn();
    const attachFiles = vi.fn();
    const editor = {
      isEditable: true,
      state: { selection: { from: 1 }, doc: { content: { size: 2 } } },
      commands: { insertImageComponent },
    };
    const plugin = DropHandlerPlugin({ editor: editor as never, fileHandler: { attachFiles } });
    const event = {
      clipboardData: {
        files: [],
        items: [
          { kind: "string", type: "text/html" },
          { kind: "file", type: "image/png", getAsFile: () => image },
        ],
      },
      preventDefault: vi.fn(),
    };

    const handled = plugin.props.handlePaste?.({ state: editor.state } as never, event as never);
    await vi.waitFor(() => expect(insertImageComponent).toHaveBeenCalled());

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(insertImageComponent).toHaveBeenCalledWith({ file: image, pos: 1, event: "paste" });
    expect(attachFiles).not.toHaveBeenCalled();
  });

  it("keeps routing pasted non-image files to attachments", async () => {
    const pdf = new File(["pdf"], "protocol.pdf", { type: "application/pdf" });
    const insertImageComponent = vi.fn();
    const attachFiles = vi.fn();
    const editor = {
      isEditable: true,
      state: { selection: { from: 1 }, doc: { content: { size: 2 } } },
      commands: { insertImageComponent },
    };
    const plugin = DropHandlerPlugin({ editor: editor as never, fileHandler: { attachFiles } });
    const event = {
      clipboardData: { files: [pdf], items: [] },
      preventDefault: vi.fn(),
    };

    const handled = plugin.props.handlePaste?.({ state: editor.state } as never, event as never);
    await vi.waitFor(() => expect(attachFiles).toHaveBeenCalled());

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(insertImageComponent).not.toHaveBeenCalled();
    expect(attachFiles).toHaveBeenCalledWith([pdf]);
  });

  it("does not intercept text-only pastes", () => {
    const insertImageComponent = vi.fn();
    const attachFiles = vi.fn();
    const editor = {
      isEditable: true,
      state: { selection: { from: 1 }, doc: { content: { size: 2 } } },
      commands: { insertImageComponent },
    };
    const plugin = DropHandlerPlugin({ editor: editor as never, fileHandler: { attachFiles } });
    const event = {
      clipboardData: {
        files: [],
        items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
      },
      preventDefault: vi.fn(),
    };

    const handled = plugin.props.handlePaste?.({ state: editor.state } as never, event as never);

    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(insertImageComponent).not.toHaveBeenCalled();
    expect(attachFiles).not.toHaveBeenCalled();
  });

  it("stores pasted image files for automatic upload while insert remains file-picker driven", () => {
    const pasteEditor = createImageEditor();
    const pastedImage = new File([], "pasted.png", { type: "image/png" });
    pasteEditor.commands.insertImageComponent({ file: pastedImage, pos: 1, event: "paste" });
    const pastedImageId = getFirstImageId(pasteEditor);

    expect(getImageComponentImageFileMap(pasteEditor)?.get(pastedImageId ?? "")).toEqual({
      event: "paste",
      file: pastedImage,
    });

    const insertEditor = createImageEditor();
    insertEditor.commands.insertImageComponent({ event: "insert" });
    const insertedImageId = getFirstImageId(insertEditor);

    expect(getImageComponentImageFileMap(insertEditor)?.get(insertedImageId ?? "")).toEqual({
      event: "insert",
      hasOpenedFileInputOnce: false,
    });

    pasteEditor.destroy();
    insertEditor.destroy();
  });
});
