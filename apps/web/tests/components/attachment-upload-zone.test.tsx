// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      ({
        "attachment.upload_zone.title": "拖拽文件或文件夹到这里，或点击选择",
        "attachment.upload_zone.active": "松开以上传",
        "attachment.upload_zone.uploading": "正在上传…",
        "attachment.upload_zone.empty": "文件夹为空或没有可上传的文件。",
        "attachment.upload_zone.invalid_type": "包含不支持的文件类型。",
        "attachment.upload_zone.too_large": "文件超过大小限制。",
        "attachment.upload_zone.empty_file": "文件不能为空。",
        "attachment.upload_zone.max_files": "一次最多可选择 {count} 个文件。",
        "attachment.upload_zone.only_one": "仅支持选择一个文件。",
        "attachment.upload_zone.invalid": "文件不符合上传要求。",
      })[key]?.replace("{count}", String(values?.count ?? "")) ?? key,
  }),
}));

const { AttachmentUploadZone } = await import("@/components/attachments/upload-zone");

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });

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

let container: HTMLDivElement;
let root: Root | null = null;

/** 挂载上传区域。 */
async function mount(element: React.ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
}

/** 构造目录条目；readEntries 首次返回内容，第二次返回空数组表示读取完成。 */
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

/** 构造 DataTransferItem。 */
function transferItem(entry: FakeFileEntry | FakeDirectoryEntry, file: File) {
  return {
    kind: "file",
    getAsFile: () => file,
    webkitGetAsEntry: () => entry,
  };
}

/** 触发 react-dropzone 会识别的原生 drop 事件。 */
async function drop(items: Array<{ entry: FakeFileEntry | FakeDirectoryEntry; file: File }>) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: ["Files"],
      items: items.map((item) => transferItem(item.entry, item.file)),
    },
  });
  await act(async () => {
    container.firstElementChild!.dispatchEvent(event);
  });
  await act(async () => await Promise.resolve());
}

beforeEach(() => {
  container = document.createElement("div");
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  vi.clearAllMocks();
});

describe("AttachmentUploadZone", () => {
  it("flattens nested folders and passes all accepted files in one batch", async () => {
    const onFiles = vi.fn();
    const first = new File(["first"], "a.txt", { type: "text/plain" });
    const second = new File(["second"], "b.md", { type: "text/markdown" });
    const nested = directory("/packet/nested", [fileEntry("/packet/nested/b.md", second)]);
    const packet = directory("/packet", [fileEntry("/packet/a.txt", first), nested]);

    await mount(<AttachmentUploadZone onFiles={onFiles} multiple />);
    await drop([{ entry: packet, file: new File([], "packet", { type: "" }) }]);

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0][0].map((file: File) => file.name)).toEqual(["a.txt", "b.md"]);
  });

  it("reports an empty folder without invoking the upload callback", async () => {
    const onFiles = vi.fn();
    const empty = directory("/empty", []);

    await mount(<AttachmentUploadZone onFiles={onFiles} multiple />);
    await drop([{ entry: empty, file: new File([], "empty", { type: "" }) }]);

    expect(onFiles).not.toHaveBeenCalled();
    expect(container.textContent).toContain("文件夹为空或没有可上传的文件。");
  });

  it("rejects a batch above maxFiles and does not partially upload it", async () => {
    const onFiles = vi.fn();
    const first = new File(["first"], "a.txt", { type: "text/plain" });
    const second = new File(["second"], "b.txt", { type: "text/plain" });

    await mount(<AttachmentUploadZone onFiles={onFiles} multiple maxFiles={1} />);
    await drop([
      { entry: fileEntry("/a.txt", first), file: first },
      { entry: fileEntry("/b.txt", second), file: second },
    ]);

    expect(onFiles).not.toHaveBeenCalled();
    expect(container.textContent).toContain("一次最多可选择 1 个文件。");
  });

  it("keeps single-file mode and reports multiple files", async () => {
    const onFiles = vi.fn();
    const first = new File(["first"], "a.txt", { type: "text/plain" });
    const second = new File(["second"], "b.txt", { type: "text/plain" });

    await mount(<AttachmentUploadZone onFiles={onFiles} />);
    await drop([
      { entry: fileEntry("/a.txt", first), file: first },
      { entry: fileEntry("/b.txt", second), file: second },
    ]);

    expect(onFiles).not.toHaveBeenCalled();
    expect(container.textContent).toContain("仅支持选择一个文件。");
  });

  it("is keyboard reachable and can open the file picker", async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    await mount(<AttachmentUploadZone onFiles={vi.fn()} />);
    const zone = container.firstElementChild as HTMLElement;

    expect(zone.tabIndex).toBe(0);
    await act(async () => {
      zone.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(click).toHaveBeenCalled();
  });
});
