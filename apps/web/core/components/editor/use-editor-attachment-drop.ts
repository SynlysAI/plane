import { useCallback, useState } from "react";

type Props = {
  onAttachFiles?: (files: File[]) => void | Promise<void>;
};

/** Track a restrained file-drag state for an editor surface. */
export function useEditorAttachmentDrop(props: Props) {
  const { onAttachFiles } = props;
  const [isAttachmentDragActive, setIsAttachmentDragActive] = useState(false);

  const canAcceptFiles = Boolean(onAttachFiles);

  const onDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!canAcceptFiles || !Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
      event.preventDefault();
      setIsAttachmentDragActive(true);
    },
    [canAcceptFiles]
  );

  const onDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setIsAttachmentDragActive(false);
  }, []);

  const onDrop = useCallback(() => setIsAttachmentDragActive(false), []);

  return {
    isAttachmentDragActive,
    attachmentDragHandlers: canAcceptFiles ? { onDragOver, onDragLeave, onDrop } : undefined,
  };
}
