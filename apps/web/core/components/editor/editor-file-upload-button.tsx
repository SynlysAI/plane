import { useRef } from "react";
import { Paperclip } from "lucide-react";
import type { EditorRefApi } from "@plane/editor";
import { useTranslation } from "@plane/i18n";
import { Tooltip } from "@makeplane/propel/components/tooltip";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { cn } from "@plane/utils";

const ACCEPTED_IMAGE_MIME_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];
const ACCEPTED_IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

type Props = {
  editorRef: { current: EditorRefApi | null };
  onAttachFiles?: (files: File[]) => void | Promise<void>;
  onFilesSelected?: (files: File[]) => void;
  disabled?: boolean;
  className?: string;
};

/** Choose files for an editor: images stay inline and other files become attachments. */
export function EditorFileUploadButton(props: Props) {
  const { editorRef, onAttachFiles, onFilesSelected, disabled = false, className } = props;
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);

  const isImageFile = (file: File) => {
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    return ACCEPTED_IMAGE_MIME_TYPES.includes(file.type) || ACCEPTED_IMAGE_EXTENSIONS.has(extension);
  };

  const handleChange = () => {
    const selectedFiles = Array.from(inputRef.current?.files ?? []);
    if (selectedFiles.length === 0) return;
    if (onFilesSelected) {
      onFilesSelected(selectedFiles);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }

    const inlineImages: File[] = [];
    const externalAttachments: File[] = [];

    for (const file of selectedFiles) {
      if (isImageFile(file)) inlineImages.push(file);
      else externalAttachments.push(file);
    }

    if (inlineImages.length > 0 && !editorRef.current?.insertImageFiles(inlineImages)) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("error"),
        message: t("attachment.editor_image.insert_failed"),
      });
    }

    if (externalAttachments.length > 0) {
      if (onAttachFiles) void onAttachFiles(externalAttachments);
      else {
        setToast({
          type: TOAST_TYPE.ERROR,
          title: t("error"),
          message: t("attachment.editor_image.invalid"),
        });
      }
    }

    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className={className}>
      <Tooltip label={t("attachment.editor_file.upload")} layout="stacked">
        <button
          type="button"
          className={cn(
            "flex size-7 items-center justify-center rounded-md text-tertiary transition-colors",
            "hover:bg-surface-hover focus-visible:ring-border-strong hover:text-secondary",
            "focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          )}
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          aria-label={t("attachment.editor_file.upload")}
        >
          <Paperclip className="size-3.5" aria-hidden />
        </button>
      </Tooltip>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept={onAttachFiles ? undefined : ACCEPTED_IMAGE_MIME_TYPES.join(",")}
        aria-label={t("attachment.editor_file.upload")}
        disabled={disabled}
        onChange={handleChange}
      />
    </div>
  );
}
