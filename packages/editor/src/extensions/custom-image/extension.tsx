/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { ReactNodeViewRenderer } from "@tiptap/react";
import { v4 as uuidv4 } from "uuid";
// constants
import { ACCEPTED_IMAGE_MIME_TYPES } from "../../constants/config";
// helpers
import { isFileValid } from "../../helpers/file";
import { insertEmptyParagraphAtNodeBoundaries } from "../../helpers/insert-empty-paragraph-at-node-boundary";
// types
import type { TFileHandler } from "../../types";
// local imports
import type { CustomImageNodeViewProps } from "./components/node-view";
import { CustomImageNodeView } from "./components/node-view";
import { CustomImageExtensionConfig } from "./extension-config";
import type { CustomImageExtensionOptions, CustomImageExtensionStorage } from "./types";
import { ECustomImageAttributeNames, ECustomImageStatus } from "./types";
import { getImageComponentImageFileMap } from "./utils";

type Props = {
  fileHandler: TFileHandler;
  isEditable: boolean;
};

export function CustomImageExtension(extensionProps: Props) {
  const { fileHandler, isEditable } = extensionProps;
  // derived values
  const { getAssetSrc, getAssetDownloadSrc, restore: restoreImageFn } = fileHandler;

  return CustomImageExtensionConfig.extend<CustomImageExtensionOptions, CustomImageExtensionStorage>({
    selectable: isEditable,
    draggable: isEditable,

    addOptions() {
      const upload = "upload" in fileHandler ? fileHandler.upload : undefined;
      const duplicate = "duplicate" in fileHandler ? fileHandler.duplicate : undefined;
      return {
        ...this.parent?.(),
        getImageDownloadSource: getAssetDownloadSrc,
        getImageSource: getAssetSrc,
        restoreImage: restoreImageFn,
        uploadImage: upload,
        duplicateImage: duplicate,
      };
    },

    addStorage() {
      const maxFileSize = "validation" in fileHandler ? fileHandler.validation?.maxFileSize : 0;

      return {
        fileMap: new Map(),
        deletedImageSet: new Map<string, boolean>(),
        maxFileSize,
        // escape markdown for images
        markdown: {
          serialize() {},
        },
      };
    },

    addCommands() {
      return {
        insertImageComponent:
          (insertProps) =>
          ({ commands }) => {
            // Early return if an invalid file is being inserted directly.
            if (
              insertProps?.file &&
              !isFileValid({
                acceptedMimeTypes: ACCEPTED_IMAGE_MIME_TYPES,
                file: insertProps.file,
                maxFileSize: this.storage.maxFileSize,
                onError: (_error, message) => alert(message),
              })
            ) {
              return false;
            }

            // Generate a unique ID to track files delivered by drag or paste.
            const fileId = uuidv4();

            const imageComponentImageFileMap = getImageComponentImageFileMap(this.editor);

            if (imageComponentImageFileMap) {
              if ((insertProps?.event === "drop" || insertProps?.event === "paste") && insertProps.file) {
                imageComponentImageFileMap.set(fileId, {
                  file: insertProps.file,
                  event: insertProps.event,
                });
              } else if (insertProps.event === "insert") {
                imageComponentImageFileMap.set(fileId, {
                  event: insertProps.event,
                  hasOpenedFileInputOnce: false,
                });
              }
            }

            const attributes = {
              [ECustomImageAttributeNames.ID]: fileId,
              [ECustomImageAttributeNames.STATUS]: ECustomImageStatus.PENDING,
            };

            if (insertProps.pos) {
              return commands.insertContentAt(insertProps.pos, {
                type: this.name,
                attrs: attributes,
              });
            }
            return commands.insertContent({
              type: this.name,
              attrs: attributes,
            });
          },
      };
    },

    addKeyboardShortcuts() {
      return {
        ArrowDown: insertEmptyParagraphAtNodeBoundaries("down", this.name),
        ArrowUp: insertEmptyParagraphAtNodeBoundaries("up", this.name),
      };
    },
    addNodeView() {
      return ReactNodeViewRenderer((nodeViewProps) => (
        <CustomImageNodeView {...nodeViewProps} node={nodeViewProps.node as CustomImageNodeViewProps["node"]} />
      ));
    },
  });
}
