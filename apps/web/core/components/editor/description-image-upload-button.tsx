/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useRef } from "react";
// plane imports
import type { EditorRefApi } from "@plane/editor";
import { useTranslation } from "@plane/i18n";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
// hooks
import { useFileSize } from "@/hooks/use-file-size";

const ACCEPTED_IMAGE_MIME_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];

type Props = {
  editorRef: { current: EditorRefApi | null };
  disabled?: boolean;
  className?: string;
};

/** 提供文件选择入口，并将选中的图片插入富文本描述正文。 */
export function DescriptionImageUploadButton(props: Props) {
  const { editorRef, disabled = false, className } = props;
  const { t } = useTranslation();
  const { maxFileSize } = useFileSize();
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = () => {
    const selectedFiles = Array.from(inputRef.current?.files ?? []);
    const validFiles: File[] = [];

    for (const file of selectedFiles) {
      if (!ACCEPTED_IMAGE_MIME_TYPES.includes(file.type)) {
        setToast({
          type: TOAST_TYPE.ERROR,
          title: t("error"),
          message: t("attachment.editor_image.invalid"),
        });
        continue;
      }
      if (file.size > maxFileSize) {
        setToast({
          type: TOAST_TYPE.ERROR,
          title: t("error"),
          message: t("attachment.file_size_limit", { size: maxFileSize / 1024 / 1024 }),
        });
        continue;
      }
      validFiles.push(file);
    }

    if (validFiles.length > 0) {
      const inserted = editorRef.current?.insertImageFiles(validFiles);
      if (!inserted) {
        setToast({
          type: TOAST_TYPE.ERROR,
          title: t("error"),
          message: t("attachment.editor_image.insert_failed"),
        });
      }
    }

    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className={className}>
      <button
        type="button"
        className="hover:bg-surface-hover focus-visible:ring-border-strong rounded-md px-2 py-1 text-caption-sm-regular text-tertiary transition-colors hover:text-secondary focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
      >
        {t("attachment.editor_image.upload")}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_IMAGE_MIME_TYPES.join(",")}
        multiple
        hidden
        aria-label={t("attachment.editor_image.upload")}
        disabled={disabled}
        onChange={handleChange}
      />
    </div>
  );
}
