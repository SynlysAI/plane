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
        "attachment.editor_image.upload": "上传图片",
        "attachment.file_size_limit": "文件大小必须小于或等于 {size}MB。",
      })[key]?.replace("{size}", String(values?.size ?? "")) ?? key,
  }),
}));
vi.mock("@plane/propel/toast", () => ({ TOAST_TYPE: { ERROR: "error" }, setToast: mocks.setToast }));
vi.mock("@/hooks/use-file-size", () => ({ useFileSize: () => ({ maxFileSize: 5 * 1024 * 1024 }) }));

const { DescriptionImageUploadButton } = await import("@/components/editor/description-image-upload-button");

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });

const MEGABYTE = 1024 * 1024;
let container: HTMLDivElement;
let root: Root | null = null;
const editorRef = { current: { insertImageFiles: mocks.insertImageFiles } };

/** 挂载正文图片上传按钮。 */
async function mount(disabled = false) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<DescriptionImageUploadButton disabled={disabled} editorRef={editorRef} />);
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

it("rejects non-image and oversized files before insertion", async () => {
  await mount();
  await selectFiles([imageFile("合同.pdf", MEGABYTE, "application/pdf"), imageFile("超限.png", 6 * MEGABYTE)]);

  expect(mocks.insertImageFiles).not.toHaveBeenCalled();
  expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ message: "仅支持上传图片文件。" }));
  expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ message: "文件大小必须小于或等于 5MB。" }));
});

it("reports an insertion failure and resets the input for retry", async () => {
  mocks.insertImageFiles.mockImplementation(() => false);
  await mount();
  await selectFiles([imageFile("图一.png")]);
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;

  expect(input.value).toBe("");
  expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ message: "图片插入失败，请重试。" }));
});
