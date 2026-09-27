/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorRefApi, CollaborationState } from "@plane/editor";
import { convertBinaryDataToBase64String, getAllDocumentFormatsFromDocumentEditorBinaryData } from "@plane/editor";
import type { TDocumentPayload } from "@plane/types";
import type { TPageInstance } from "@/store/pages/base-page";
import { saveDisconnectedDescription, type TOfflineSaveOutcome } from "@/hooks/page-description-save";

type TArgs = {
  editorRef: React.RefObject<EditorRefApi | null>;
  fetchPageDescription: () => Promise<ArrayBuffer>;
  collaborationState: CollaborationState | null;
  updatePageDescription: (data: TDocumentPayload) => Promise<void>;
  page: TPageInstance;
};

/**
 * 协作断开后的正文保存。只响应一次手动保存，不启动自动写回。
 */
export const usePageFallback = (args: TArgs) => {
  const { editorRef, fetchPageDescription, collaborationState, updatePageDescription, page } = args;
  const hasConnectionFailed = collaborationState?.stage.kind === "disconnected";
  const savingRef = useRef(false);
  const [isSavingDescription, setIsSavingDescription] = useState(false);
  const [saveResult, setSaveResult] = useState<TOfflineSaveOutcome | "idle">("idle");

  useEffect(() => {
    if (!hasConnectionFailed) setSaveResult("idle");
  }, [hasConnectionFailed]);

  const savePageDescription = useCallback(async () => {
    if (!hasConnectionFailed || savingRef.current) return;
    const editor = editorRef.current;
    if (!editor) return;

    savingRef.current = true;
    setIsSavingDescription(true);
    try {
      const outcome = await saveDisconnectedDescription({
        getLocal: () => editor.getDocument(),
        fetchServer: fetchPageDescription,
        readServerHtml: (binary) => getAllDocumentFormatsFromDocumentEditorBinaryData(binary, false).contentHTML,
        fallbackHtml: page.description_html ?? "",
        encodeBinary: convertBinaryDataToBase64String,
        update: updatePageDescription,
      });
      setSaveResult(outcome);
    } finally {
      savingRef.current = false;
      setIsSavingDescription(false);
    }
  }, [editorRef, fetchPageDescription, hasConnectionFailed, page.description_html, updatePageDescription]);

  return {
    isFetchingFallbackBinary: false,
    isSavingDescription,
    savePageDescription,
    saveResult,
    hasConnectionFailed,
  };
};
