// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insertImageFiles: vi.fn(() => true),
  setToast: vi.fn(),
}));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      ({
        "attachment.editor_image.invalid": "仅支持上传图片文件。",
        "attachment.editor_image.insert_failed": "图片插入失败，请重试。",
        "attachment.editor_file.upload": "添加附件",
      })[key]?.replace("{size}", String(values?.size ?? "")) ?? key,
  }),
}));
vi.mock("@plane/propel/toast", () => ({ TOAST_TYPE: { ERROR: "error" }, setToast: mocks.setToast }));
vi.mock("@makeplane/propel/components/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { EditorFileUploadButton } = await import("@/components/editor/editor-file-upload-button");

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });

const MEGABYTE = 1024 * 1024;
let container: HTMLDivElement;
let root: Root | null = null;
const editorRef = { current: { insertImageFiles: mocks.insertImageFiles } };

/** 挂载正文图片上传按钮。 */
async function mount(
  disabled = false,
  onAttachFiles?: (files: File[]) => void,
  onFilesSelected?: (files: File[]) => void
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <EditorFileUploadButton
        disabled={disabled}
        editorRef={editorRef}
        onAttachFiles={onAttachFiles}
        onFilesSelected={onFilesSelected}
      />
    );
  });
}

/** 模拟选择图片文件。 */
async function selectFiles(files: File[]) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: files });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => await Promise.resolve());
}

/** 创建可指定大小的文件。 */
function imageFile(name: string, size = MEGABYTE, type = "image/png") {
  const result = new File(["plane"], name, { type });
  Object.defineProperty(result, "size", { value: size });
  return result;
}

beforeEach(() => {
  editorRef.current = { insertImageFiles: mocks.insertImageFiles };
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  vi.clearAllMocks();
  mocks.insertImageFiles.mockImplementation(() => true);
});

it("inserts every selected image through the editor ref", async () => {
  await mount();
  const first = imageFile("图一.png");
  const second = imageFile("图二.jpeg");
  await selectFiles([first, second]);

  expect(mocks.insertImageFiles).toHaveBeenCalledTimes(1);
  expect(mocks.insertImageFiles).toHaveBeenCalledWith([first, second]);
  expect(mocks.setToast).not.toHaveBeenCalled();
});

it("keeps images inline and sends other files to the attachment queue", async () => {
  const onAttachFiles = vi.fn();
  const image = imageFile("图一.png");
  const attachment = imageFile("合同.pdf", MEGABYTE, "application/pdf");
  await mount(false, onAttachFiles);
  await selectFiles([image, attachment]);

  expect(mocks.insertImageFiles).toHaveBeenCalledWith([image]);
  expect(onAttachFiles).toHaveBeenCalledWith([attachment]);
  expect(mocks.setToast).not.toHaveBeenCalled();
});

it("rejects non-image files when the surface has no attachment queue", async () => {
  await mount();
  await selectFiles([imageFile("合同.pdf", MEGABYTE, "application/pdf")]);

  expect(mocks.insertImageFiles).not.toHaveBeenCalled();
  expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ message: "仅支持上传图片文件。" }));
});

it("routes all selected files to a host that must validate the current context", async () => {
  const onFilesSelected = vi.fn();
  const image = imageFile("图一.png");
  const attachment = imageFile("合同.pdf", MEGABYTE, "application/pdf");
  await mount(false, undefined, onFilesSelected);
  await selectFiles([image, attachment]);

  expect(onFilesSelected).toHaveBeenCalledWith([image, attachment]);
  expect(mocks.insertImageFiles).not.toHaveBeenCalled();
});

it("reports an insertion failure and resets the input for retry", async () => {
  mocks.insertImageFiles.mockImplementation(() => false);
  await mount();
  await selectFiles([imageFile("图一.png")]);
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;

  expect(input.value).toBe("");
  expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ message: "图片插入失败，请重试。" }));
});
