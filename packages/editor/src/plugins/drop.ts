/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { Editor } from "@tiptap/core";
import { fromEvent } from "file-selector";
import { Plugin, PluginKey } from "@tiptap/pm/state";
// constants
import { ACCEPTED_ATTACHMENT_MIME_TYPES, ACCEPTED_IMAGE_MIME_TYPES } from "../constants/config";
// types
import type { TEditorCommands, TExtensions, TFileHandler } from "@/types";

type Props = {
  disabledExtensions?: TExtensions[];
  flaggedExtensions?: TExtensions[];
  editor: Editor;
  fileHandler: TFileHandler;
};

export const DropHandlerPlugin = (props: Props): Plugin => {
  const { disabledExtensions, editor, fileHandler } = props;

  return new Plugin({
    key: new PluginKey("drop-handler-plugin"),
    props: {
      handlePaste: (view, event) => {
        if (
          editor.isEditable &&
          event.clipboardData &&
          event.clipboardData.files &&
          event.clipboardData.files.length > 0
        ) {
          event.preventDefault();
          const files = Array.from(event.clipboardData.files);
          void dispatchEditorFiles({
            disabledExtensions,
            editor,
            files,
            initialPos: view.state.selection.from,
            attachFiles: fileHandler.attachFiles,
          });
          return true;
        }
        return false;
      },
      handleDrop: (view, event, _slice, moved) => {
        if (
          editor.isEditable &&
          !moved &&
          event.dataTransfer &&
          ((event.dataTransfer.files?.length ?? 0) > 0 || (event.dataTransfer.items?.length ?? 0) > 0)
        ) {
          event.preventDefault();
          const initialPos =
            view.posAtCoords({
              left: event.clientX,
              top: event.clientY,
            })?.pos ?? view.state.selection.from;

          void fromEvent(event)
            .then((items) =>
              dispatchEditorFiles({
                disabledExtensions,
                editor,
                files: items.filter(isFileLike),
                initialPos,
                attachFiles: fileHandler.attachFiles,
                event: "drop",
              })
            )
            .catch((error) => console.error("Error in reading dropped editor files:", error));
          return true;
        }
        return false;
      },
    },
  });
};

const IMAGE_FILE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

/** Identify inline images by MIME type or a common image extension. */
function isImageFile(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ACCEPTED_IMAGE_MIME_TYPES.includes(file.type) || IMAGE_FILE_EXTENSIONS.has(extension);
}

/** Accept File objects across DOM realms without relying on instanceof. */
function isFileLike(item: unknown): item is File {
  if (typeof item !== "object" || item === null) return false;
  const file = item as Partial<File>;
  return (
    typeof file.name === "string" &&
    typeof file.type === "string" &&
    typeof file.size === "number" &&
    typeof file.slice === "function"
  );
}

type TDispatchEditorFilesArgs = {
  disabledExtensions?: TExtensions[];
  editor: Editor;
  files: File[];
  initialPos: number;
  attachFiles?: (files: File[]) => void | Promise<void>;
  event?: "insert" | "drop";
};

/** Keep images inline and hand all other files to the host attachment surface. */
async function dispatchEditorFiles(args: TDispatchEditorFilesArgs) {
  const { attachFiles, disabledExtensions, editor, event = "insert", files, initialPos } = args;
  const inlineImages = files.filter(isImageFile);
  const externalAttachments = files.filter((file) => !isImageFile(file));

  if (inlineImages.length > 0) {
    await insertFilesSafely({
      disabledExtensions,
      editor,
      files: inlineImages,
      initialPos,
      event,
    });
  }
  if (files.length === 0 || externalAttachments.length > 0) await attachFiles?.(externalAttachments);
}

type InsertFilesSafelyArgs = {
  disabledExtensions?: TExtensions[];
  flaggedExtensions?: TExtensions[];
  editor: Editor;
  event: "insert" | "drop";
  files: File[];
  initialPos: number;
  type?: Extract<TEditorCommands, "attachment" | "image">;
};

export const insertFilesSafely = async (args: InsertFilesSafelyArgs) => {
  const { disabledExtensions, editor, event, files, initialPos, type } = args;
  let pos = initialPos;

  for (const file of files) {
    // safe insertion
    const docSize = editor.state.doc.content.size;
    pos = Math.min(pos, docSize);

    let fileType: "image" | "attachment" | null = null;

    try {
      if (type) {
        if (["image", "attachment"].includes(type)) fileType = type;
        else throw new Error("Wrong file type passed");
      } else {
        if (isImageFile(file)) fileType = "image";
        else if (ACCEPTED_ATTACHMENT_MIME_TYPES.includes(file.type)) fileType = "attachment";
      }
      // insert file depending on the type at the current position
      if (fileType === "image" && !disabledExtensions?.includes("image")) {
        editor.commands.insertImageComponent({
          file,
          pos,
          event,
        });
      } else if (fileType === "attachment") {
      }
    } catch (error) {
      console.error(`Error while ${event}ing file:`, error);
    }

    // Move to the next position
    pos += 1;
  }
};
