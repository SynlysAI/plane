/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { useCallback, useRef, useState } from "react";
// plane constants
import type { EIssueCommentAccessSpecifier } from "@plane/constants";
// plane imports
import { LiteTextEditorWithRef } from "@plane/editor";
import type { EditorRefApi, ILiteTextEditorProps, TFileHandler, TEditorCommands } from "@plane/editor";
import { useTranslation } from "@plane/i18n";
import type { MakeOptional, TSearchEntityRequestPayload, TSearchResponse } from "@plane/types";
import { cn, isCommentEmpty } from "@plane/utils";
// components
import { EditorMentionsRoot } from "@/components/editor/embeds/mentions";
import { IssueCommentToolbar } from "@/components/editor/lite-text/toolbar";
import { useEditorAttachmentDrop } from "@/components/editor/use-editor-attachment-drop";
// hooks
import { useEditorConfig, useEditorMention } from "@/hooks/editor";
import { useMember } from "@/hooks/store/use-member";
import { useParseEditorContent } from "@/hooks/use-parse-editor-content";
// plane web hooks
import { useEditorFlagging } from "@/hooks/use-editor-flagging";
// plane web service
import { WorkspaceService } from "@/services/workspace.service";
import { splitEditorFiles } from "@/components/editor/editor-files";
import { LiteToolbar } from "./lite-toolbar";
const workspaceService = new WorkspaceService();

function isMutableRefObject<T>(forwardedRef: React.ForwardedRef<T>): forwardedRef is React.MutableRefObject<T | null> {
  return !!forwardedRef && typeof forwardedRef === "object" && "current" in forwardedRef;
}

type LiteTextEditorWrapperProps = MakeOptional<
  Omit<ILiteTextEditorProps, "fileHandler" | "mentionHandler" | "extendedEditorProps">,
  "disabledExtensions" | "flaggedExtensions" | "getEditorMetaData"
> & {
  workspaceSlug: string;
  workspaceId: string;
  projectId?: string;
  mentionSearch?: (payload: TSearchEntityRequestPayload) => Promise<TSearchResponse>;
  accessSpecifier?: EIssueCommentAccessSpecifier;
  handleAccessChange?: (accessKey: EIssueCommentAccessSpecifier) => void;
  showAccessSpecifier?: boolean;
  showSubmitButton?: boolean;
  isSubmitting?: boolean;
  showToolbarInitially?: boolean;
  variant?: "full" | "lite" | "none";
  issue_id?: string;
  parentClassName?: string;
  editorClassName?: string;
  submitButtonText?: string;
  disabledMenuItems?: TEditorCommands[];
  onAttachFiles?: (files: File[]) => void | Promise<void>;
  attachmentContent?: React.ReactNode;
  hasAttachments?: boolean;
  isSubmitDisabled?: boolean;
  fileHandlerOverrides?: Partial<TFileHandler>;
} & (
    | {
        editable: false;
      }
    | {
        editable: true;
        uploadFile: TFileHandler["upload"];
        duplicateFile: TFileHandler["duplicate"];
      }
  );

export const LiteTextEditor = React.forwardRef(function LiteTextEditor(
  props: LiteTextEditorWrapperProps,
  ref: React.ForwardedRef<EditorRefApi>
) {
  const { t } = useTranslation();
  const {
    containerClassName,
    editable,
    workspaceSlug,
    workspaceId,
    projectId,
    mentionSearch,
    issue_id,
    accessSpecifier,
    handleAccessChange,
    showAccessSpecifier = false,
    showSubmitButton = true,
    isSubmitting = false,
    showToolbarInitially = true,
    variant = "full",
    parentClassName = "",
    placeholder = t("issue.comments.placeholder"),
    disabledExtensions: additionalDisabledExtensions = [],
    editorClassName = "",
    showPlaceholderOnEmpty = true,
    submitButtonText = "common.comment",
    disabledMenuItems,
    onAttachFiles,
    attachmentContent,
    hasAttachments = false,
    isSubmitDisabled = false,
    fileHandlerOverrides,
    ...rest
  } = props;
  // states
  const isLiteVariant = variant === "lite";
  const isFullVariant = variant === "full";
  const [isFocused, setIsFocused] = useState(isFullVariant ? showToolbarInitially : true);
  const [editorRef, setEditorRef] = useState<EditorRefApi | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const enterHandlerRef = useRef(rest.onEnterKeyPress);
  enterHandlerRef.current = rest.onEnterKeyPress;
  // TipTap 初始化后会保留快捷键扩展，回车必须读取最新正文及附件草稿状态。
  const handleEnterKeyPress = useCallback((event?: React.KeyboardEvent) => enterHandlerRef.current?.(event), []);
  // editor flaggings
  const { liteText: liteTextEditorExtensions } = useEditorFlagging({
    workspaceSlug,
    projectId,
  });
  // store hooks
  const { getUserDetails } = useMember();
  // parse content
  const { getEditorMetaData } = useParseEditorContent({
    projectId,
    workspaceSlug,
  });
  // use editor mention
  const { fetchMentions } = useEditorMention({
    searchEntity:
      mentionSearch ??
      (async (payload) =>
        await workspaceService.searchEntity(workspaceSlug, {
          ...payload,
          project_id: projectId,
          issue_id,
        })),
  });
  // editor config
  const { getEditorFileHandlers } = useEditorConfig();
  // derived values
  const isEmpty = isCommentEmpty(props.initialValue) && !hasAttachments;

  /** Keep selected images inline and route other files to the comment attachment queue. */
  const handleFileSelection = useCallback(
    (files: File[]) => {
      if (files.length === 0) {
        if (onAttachFiles) void onAttachFiles(files);
        return;
      }
      const { inlineImages, externalAttachments } = splitEditorFiles(files);
      if (inlineImages.length > 0) editorRef?.insertImageFiles(inlineImages);
      if (externalAttachments.length > 0 && onAttachFiles) void onAttachFiles(externalAttachments);
    },
    [editorRef, onAttachFiles]
  );
  const { isAttachmentDragActive, attachmentDragHandlers } = useEditorAttachmentDrop({
    onFiles: editable && onAttachFiles ? handleFileSelection : undefined,
  });

  return (
    <div
      className={cn(
        "relative rounded-sm border border-subtle",
        isAttachmentDragActive && "border-accent-strong bg-accent-primary/5 ring-1 ring-accent-strong/30",
        {
          "p-3": editable && !isLiteVariant,
        },
        parentClassName
      )}
      {...attachmentDragHandlers}
      onFocus={() => isFullVariant && !showToolbarInitially && setIsFocused(true)}
      onBlur={() => isFullVariant && !showToolbarInitially && setIsFocused(false)}
    >
      {/* Wrapper for lite toolbar layout */}
      <div className={cn(isLiteVariant && editable ? "flex items-end gap-1" : "")}>
        {/* Main Editor - always rendered once */}
        <div className={cn(isLiteVariant && editable ? "min-w-0 flex-1" : "")}>
          <LiteTextEditorWithRef
            ref={ref}
            disabledExtensions={[...liteTextEditorExtensions.disabled, ...additionalDisabledExtensions]}
            editable={editable}
            flaggedExtensions={liteTextEditorExtensions.flagged}
            fileHandler={{
              ...getEditorFileHandlers({
                projectId,
                uploadFile: editable ? props.uploadFile : async () => "",
                duplicateFile: editable ? props.duplicateFile : async () => "",
                workspaceId,
                workspaceSlug,
                fileHandlerOverrides,
              }),
              ...(editable && onAttachFiles ? { attachFiles: handleFileSelection } : {}),
            }}
            getEditorMetaData={getEditorMetaData}
            handleEditorReady={(ready) => {
              if (ready) {
                setEditorRef(isMutableRefObject<EditorRefApi>(ref) ? ref.current : null);
              }
            }}
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
            placeholder={placeholder}
            showPlaceholderOnEmpty={showPlaceholderOnEmpty}
            containerClassName={cn(containerClassName, "relative", {
              "p-2": !editable,
              "min-h-[72px]": editable,
            })}
            extendedEditorProps={{}}
            editorClassName={editorClassName}
            {...rest}
            onEnterKeyPress={handleEnterKeyPress}
          />
        </div>

        {/* Lite Toolbar - conditionally rendered */}
        {isLiteVariant && editable && (
          <LiteToolbar
            executeCommand={(item) => {
              // TODO: update this while toolbar homogenization
              // @ts-expect-error type mismatch here
              editorRef?.executeMenuItemCommand({
                itemKey: item.itemKey,
                ...item.extraProps,
              });
            }}
            onSubmit={(e) => rest.onEnterKeyPress?.(e)}
            isSubmitting={isSubmitting}
            isEmpty={isEmpty}
          />
        )}
      </div>

      {isAttachmentDragActive && (
        <div aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit] bg-accent-primary/5" />
      )}

      {editable && onAttachFiles && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          aria-label="选择评论附件"
          disabled={isSubmitting}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            if (files.length > 0) handleFileSelection(files);
            event.target.value = "";
          }}
        />
      )}
      {attachmentContent}
      {onAttachFiles && (
        <span role="status" className="sr-only">
          {isAttachmentDragActive ? t("attachment.upload_zone.active") : ""}
        </span>
      )}

      {/* Full Toolbar - conditionally rendered */}
      {isFullVariant && editable && (
        <div
          className={cn(
            "origin-top overflow-hidden transition-all duration-300 ease-out",
            isFocused ? "mt-3 max-h-[200px] scale-y-100 opacity-100" : "invisible max-h-0 scale-y-0 opacity-0"
          )}
        >
          <IssueCommentToolbar
            disabledMenuItems={disabledMenuItems}
            accessSpecifier={accessSpecifier}
            executeCommand={(item) => {
              // TODO: update this while toolbar homogenization
              // @ts-expect-error type mismatch here
              editorRef?.executeMenuItemCommand({
                itemKey: item.itemKey,
                ...item.extraProps,
              });
            }}
            handleAccessChange={handleAccessChange}
            handleSubmit={(e) => rest.onEnterKeyPress?.(e)}
            isCommentEmpty={isEmpty}
            isSubmitting={isSubmitting}
            showAccessSpecifier={showAccessSpecifier}
            editorRef={editorRef}
            showSubmitButton={showSubmitButton}
            submitButtonText={submitButtonText}
            onAttachFiles={onAttachFiles ? () => fileInputRef.current?.click() : undefined}
            isSubmitDisabled={isSubmitDisabled}
          />
        </div>
      )}
    </div>
  );
});

LiteTextEditor.displayName = "LiteTextEditor";
