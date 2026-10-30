/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { forwardRef, useCallback, useRef } from "react";
import { useTranslation } from "@plane/i18n";
// plane imports
import { RichTextEditorWithRef } from "@plane/editor";
import type { EditorRefApi, IRichTextEditorProps, TFileHandler } from "@plane/editor";
import type { MakeOptional, TSearchEntityRequestPayload, TSearchResponse } from "@plane/types";
import { cn } from "@plane/utils";
// components
import { EditorMentionsRoot } from "@/components/editor/embeds/mentions";
import { splitEditorFiles } from "@/components/editor/editor-files";
// hooks
import { useEditorConfig, useEditorMention } from "@/hooks/editor";
import { useMember } from "@/hooks/store/use-member";
import { useParseEditorContent } from "@/hooks/use-parse-editor-content";
// plane web hooks
import { useEditorFlagging } from "@/hooks/use-editor-flagging";
import { useEditorAttachmentDrop } from "@/components/editor/use-editor-attachment-drop";

type RichTextEditorWrapperProps = MakeOptional<
  Omit<IRichTextEditorProps, "fileHandler" | "mentionHandler" | "extendedEditorProps">,
  "disabledExtensions" | "editable" | "flaggedExtensions" | "getEditorMetaData"
> & {
  workspaceSlug: string;
  workspaceId: string;
  projectId?: string;
  issueSequenceId?: number;
  onAttachFiles?: (files: File[]) => void | Promise<void>;
  /** 科研等受控内容可覆盖资源路由，统一执行所属对象的权限检查。 */
  fileHandlerOverrides?: Partial<TFileHandler>;
} & (
    | {
        editable: false;
      }
    | {
        editable: true;
        searchMentionCallback: (payload: TSearchEntityRequestPayload) => Promise<TSearchResponse>;
        uploadFile: TFileHandler["upload"];
        duplicateFile: TFileHandler["duplicate"];
      }
  );

export const RichTextEditor = forwardRef(function RichTextEditor(
  props: RichTextEditorWrapperProps,
  ref: React.ForwardedRef<EditorRefApi>
) {
  const { t } = useTranslation();
  const {
    containerClassName,
    editable,
    workspaceSlug,
    workspaceId,
    projectId,
    onAttachFiles,
    disabledExtensions: additionalDisabledExtensions = [],
    fileHandlerOverrides,
    ...rest
  } = props;
  // store hooks
  const { getUserDetails } = useMember();
  // editor flaggings
  const { richText: richTextEditorExtensions } = useEditorFlagging({
    workspaceSlug,
    projectId,
  });
  // use editor mention
  const { fetchMentions } = useEditorMention({
    searchEntity: editable ? async (payload) => await props.searchMentionCallback(payload) : async () => ({}),
  });
  // editor config
  const { getEditorFileHandlers } = useEditorConfig();
  // parse content
  const { getEditorMetaData } = useParseEditorContent({
    projectId,
    workspaceSlug,
  });
  const localEditorRef = useRef<EditorRefApi | null>(null);
  const setEditorRef = useCallback(
    (instance: EditorRefApi | null) => {
      localEditorRef.current = instance;
      if (!ref) return;
      if (typeof ref === "function") ref(instance);
      else ref.current = instance;
    },
    [ref]
  );

  /** Keep inline images in the document and route other files to the host attachment queue. */
  const handleFileSelection = useCallback(
    (files: File[]) => {
      if (files.length === 0) {
        void onAttachFiles?.([]);
        return;
      }
      const { inlineImages, externalAttachments } = splitEditorFiles(files);
      if (inlineImages.length > 0) localEditorRef.current?.insertImageFiles(inlineImages);
      if (externalAttachments.length > 0 && onAttachFiles) void onAttachFiles(externalAttachments);
    },
    [onAttachFiles]
  );
  const canAcceptFiles = editable && Boolean(onAttachFiles);
  const { isAttachmentDragActive, attachmentDragHandlers } = useEditorAttachmentDrop({
    onFiles: canAcceptFiles ? handleFileSelection : undefined,
  });

  return (
    <div
      className={cn(
        "relative rounded-sm transition-colors",
        isAttachmentDragActive && "bg-accent-primary/5 ring-1 ring-accent-strong/30"
      )}
      {...attachmentDragHandlers}
    >
      <RichTextEditorWithRef
        ref={setEditorRef}
        disabledExtensions={[...richTextEditorExtensions.disabled, ...(additionalDisabledExtensions ?? [])]}
        editable={editable}
        flaggedExtensions={richTextEditorExtensions.flagged}
        fileHandler={{
          ...getEditorFileHandlers({
            projectId,
            uploadFile: editable ? props.uploadFile : async () => "",
            duplicateFile: editable ? props.duplicateFile : async () => "",
            workspaceId,
            workspaceSlug,
          }),
          ...(canAcceptFiles ? { attachFiles: handleFileSelection } : {}),
          ...fileHandlerOverrides,
        }}
        getEditorMetaData={getEditorMetaData}
        mentionHandler={{
          searchCallback: async (query) => {
            const res = await fetchMentions(query);
            if (!res) throw new Error("Failed in fetching mentions");
            return res;
          },
          renderComponent: EditorMentionsRoot,
          getMentionedEntityDetails: (id) => ({
            display_name: getUserDetails(id)?.display_name ?? "",
          }),
        }}
        extendedEditorProps={{}}
        {...rest}
        containerClassName={cn("relative pb-3 pl-3", containerClassName)}
      />
      {isAttachmentDragActive && (
        <div aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit] bg-accent-primary/5" />
      )}
      {onAttachFiles && (
        <span role="status" className="sr-only">
          {isAttachmentDragActive ? t("attachment.upload_zone.active") : ""}
        </span>
      )}
    </div>
  );
});

RichTextEditor.displayName = "RichTextEditor";
