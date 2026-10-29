/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useState, type ReactNode } from "react";
import { ErrorCode, useDropzone, type Accept, type FileRejection } from "react-dropzone";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";

type TUploadZoneVariant = "block" | "compact" | "inline";

type Props = {
  onFiles: (files: File[]) => void | Promise<void>;
  onReject?: () => void;
  accept?: Accept;
  multiple?: boolean;
  maxFiles?: number;
  maxSize?: number;
  minSize?: number;
  disabled?: boolean;
  uploading?: boolean;
  error?: string | null;
  title?: string;
  hint?: string;
  activeTitle?: string;
  uploadingTitle?: string;
  inputAriaLabel?: string;
  variant?: TUploadZoneVariant;
  className?: string;
  children?: ReactNode;
};

const VARIANT_CLASSNAMES: Record<TUploadZoneVariant, string> = {
  block: "min-h-[72px] px-3 py-3",
  compact: "min-h-[52px] px-3 py-2",
  inline: "inline-flex min-h-9 px-2.5 py-1.5",
};

/** Convert react-dropzone rejections into one stable, user-facing message. */
function getRejectionMessage(
  rejections: FileRejection[],
  multiple: boolean,
  maxFiles: number,
  translate: ReturnType<typeof useTranslation>["t"]
) {
  const errors = rejections.flatMap((rejection) => rejection.errors);
  if (multiple && errors.some((error) => error.code === ErrorCode.TooManyFiles)) {
    return translate("attachment.upload_zone.max_files", { count: maxFiles });
  }
  if (!multiple && rejections.length > 1) return translate("attachment.upload_zone.only_one");
  if (errors.some((error) => error.code === ErrorCode.FileInvalidType)) {
    return translate("attachment.upload_zone.invalid_type");
  }
  if (errors.some((error) => error.code === ErrorCode.FileTooLarge)) {
    return translate("attachment.upload_zone.too_large");
  }
  if (errors.some((error) => error.code === ErrorCode.FileTooSmall)) {
    return translate("attachment.upload_zone.empty_file");
  }
  return translate("attachment.upload_zone.invalid");
}

/** Shared drag-and-drop surface for single or flattened multi-file attachment uploads. */
export function AttachmentUploadZone(props: Props) {
  const {
    onFiles,
    accept,
    multiple = false,
    maxFiles,
    maxSize,
    minSize = 1,
    disabled = false,
    uploading = false,
    error,
    title,
    hint,
    activeTitle,
    uploadingTitle,
    inputAriaLabel,
    onReject,
    variant = "block",
    className,
    children,
  } = props;
  const { t } = useTranslation();
  const [zoneError, setZoneError] = useState<string | null>(null);

  const onDrop = useCallback(
    (acceptedFiles: File[], rejectedFiles: FileRejection[]) => {
      if (rejectedFiles.length > 0) {
        setZoneError(
          getRejectionMessage(rejectedFiles, multiple, maxFiles ?? acceptedFiles.length + rejectedFiles.length, t)
        );
        onReject?.();
        return;
      }
      if (acceptedFiles.length === 0) {
        setZoneError(t("attachment.upload_zone.empty"));
        return;
      }
      setZoneError(null);
      void onFiles(acceptedFiles);
    },
    [maxFiles, multiple, onFiles, onReject, t]
  );

  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    onDrop,
    accept,
    multiple,
    maxFiles,
    maxSize,
    minSize,
    disabled: disabled || uploading,
  });

  const resolvedTitle = uploading
    ? (uploadingTitle ?? t("attachment.upload_zone.uploading"))
    : isDragActive
      ? (activeTitle ?? t("attachment.upload_zone.active"))
      : (title ?? t("attachment.upload_zone.title"));
  const resolvedError = error ?? zoneError;

  return (
    <div
      {...getRootProps({
        className: cn(
          "flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-subtle bg-surface-1 text-center text-12 text-secondary transition-colors outline-none",
          "focus-visible:border-accent-primary hover:bg-surface-2",
          VARIANT_CLASSNAMES[variant],
          isDragActive && "border-accent-primary bg-surface-2 text-primary",
          isDragReject && "border-danger-strong text-danger-primary",
          (disabled || uploading) && "cursor-not-allowed opacity-60",
          variant === "inline" && "flex-row text-left",
          className
        ),
        "aria-busy": uploading,
      })}
    >
      <input
        {...getInputProps({
          disabled: disabled || uploading,
          "aria-label": inputAriaLabel ?? title ?? t("attachment.upload_zone.title"),
        })}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={cn(variant === "inline" && "truncate", resolvedError && "text-danger-primary")}>
          {resolvedError ?? resolvedTitle}
        </span>
        {hint && !resolvedError && !isDragActive && !uploading ? (
          <span className="text-11 text-tertiary">{hint}</span>
        ) : null}
      </span>
      {children}
    </div>
  );
}
