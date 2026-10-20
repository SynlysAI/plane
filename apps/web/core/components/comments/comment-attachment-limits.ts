/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TCommentAttachmentCategory, TCommentAttachmentLimits } from "@plane/types";

const CATEGORY_LABELS: Record<TCommentAttachmentCategory, string> = {
  image: "图片文件",
  pdf: "PDF 文件",
  markdown: "Markdown 文件",
  office: "办公及其他附件",
};

/** 判断评论附件使用哪一类工作区平台额度。
 *
 * @param file 待分类的浏览器文件对象。
 * @returns 图片、PDF、Markdown 或办公及其他分类。
 */
export function getCommentAttachmentCategory(file: { name: string; type?: string }): TCommentAttachmentCategory {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const contentType = (file.type ?? "").split(";", 1)[0].trim().toLowerCase();
  if (extension === "pdf" || contentType === "application/pdf") return "pdf";
  if (
    extension === "md" ||
    extension === "markdown" ||
    contentType === "text/markdown" ||
    contentType === "text/x-markdown"
  ) {
    return "markdown";
  }
  if (contentType.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension)) {
    return "image";
  }
  return "office";
}

/** 按分类校验文件大小，返回可直接展示的错误文案。
 *
 * @param limits 项目级四类附件额度；尚未加载时为 null。
 * @param file 待校验的浏览器文件对象。
 * @returns 校验通过时为 null，否则为错误文案。
 */
export function getCommentAttachmentLimitError(
  limits: TCommentAttachmentLimits | null,
  file: { name: string; size: number; type?: string }
): string | null {
  if (!limits) return "无法获取当前工作区附件限制";
  if (file.size <= 0) return "文件不能为空";
  const category = getCommentAttachmentCategory(file);
  const limit = limits[category];
  if (file.size > limit.max_bytes) {
    return `${CATEGORY_LABELS[category]}不能超过 ${limit.max_mb} MB。`;
  }
  return null;
}
