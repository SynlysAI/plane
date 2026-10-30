import { useCallback, useEffect, useRef, useState } from "react";
import { fromEvent } from "file-selector";
import { isFileLike } from "./editor-files";

type Props = {
  onFiles?: (files: File[]) => void | Promise<void>;
};

/** Track and accept file drops across the complete visible editor surface. */
export function useEditorAttachmentDrop(props: Props) {
  const { onFiles } = props;
  const [isAttachmentDragActive, setIsAttachmentDragActive] = useState(false);
  const onFilesRef = useRef(onFiles);

  useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  const canAcceptFiles = Boolean(onFiles);

  const onDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!canAcceptFiles || !Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setIsAttachmentDragActive(true);
    },
    [canAcceptFiles]
  );

  const onDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setIsAttachmentDragActive(false);
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      const handledByEditor = event.defaultPrevented;
      setIsAttachmentDragActive(false);
      if (handledByEditor || !canAcceptFiles) return;
      if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;

      event.preventDefault();
      event.stopPropagation();
      void fromEvent(event)
        .then((items) => onFilesRef.current?.(items.filter(isFileLike)))
        .catch((error) => console.error("Error in reading dropped editor files:", error));
    },
    [canAcceptFiles]
  );

  return {
    isAttachmentDragActive,
    attachmentDragHandlers: canAcceptFiles ? { onDragOver, onDragLeave, onDrop } : undefined,
  };
}
