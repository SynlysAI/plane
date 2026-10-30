const IMAGE_FILE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

/** 判断文件是否应作为编辑器正文中的内联图片处理。 */
export function isInlineImageFile(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return file.type.startsWith("image/") || IMAGE_FILE_EXTENSIONS.has(extension);
}

/** 将浏览器或文件夹展开结果拆分为内联图片与外部附件。 */
export function splitEditorFiles(files: File[]) {
  return {
    inlineImages: files.filter((file) => isInlineImageFile(file)),
    externalAttachments: files.filter((file) => !isInlineImageFile(file)),
  };
}

/** 兼容跨 DOM realm 的 File 对象，避免依赖 instanceof 判断。 */
export function isFileLike(item: unknown): item is File {
  if (typeof item !== "object" || item === null) return false;
  const file = item as Partial<File>;
  return (
    typeof file.name === "string" &&
    typeof file.type === "string" &&
    typeof file.size === "number" &&
    typeof file.slice === "function"
  );
}
