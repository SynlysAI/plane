// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../packages/editor/src/constants/config", () => ({
  ACCEPTED_ATTACHMENT_MIME_TYPES: ["application/pdf"],
  ACCEPTED_IMAGE_MIME_TYPES: ["image/png"],
}));

const { DropHandlerPlugin } = await import("../../../../packages/editor/src/plugins/drop");

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
