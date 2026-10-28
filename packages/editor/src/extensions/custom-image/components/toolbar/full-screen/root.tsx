/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { FullScreenOutline } from "@makeplane/propel/icons";
import { useEffect } from "react";
// plane imports
import { Tooltip } from "@plane/propel/tooltip";
// local imports
import { ImageFullScreenModal } from "./modal";

type Props = {
  image: {
    aspectRatio: number;
    downloadSrc: string;
    height: string;
    src: string;
    width: string;
  };
  isTouchDevice: boolean;
  isFullScreenEnabled: boolean;
  toggleFullScreenMode: (value: boolean) => void;
  toggleToolbarViewStatus: (val: boolean) => void;
};

export function ImageFullScreenActionRoot(props: Props) {
  const { image, isTouchDevice, isFullScreenEnabled, toggleFullScreenMode, toggleToolbarViewStatus } = props;
  // derived values
  const { downloadSrc, src, width, aspectRatio } = image;

  useEffect(() => {
    toggleToolbarViewStatus(isFullScreenEnabled);
  }, [isFullScreenEnabled, toggleToolbarViewStatus]);

  return (
    <>
      <ImageFullScreenModal
        aspectRatio={aspectRatio}
        downloadSrc={downloadSrc}
        isFullScreenEnabled={isFullScreenEnabled}
        isTouchDevice={isTouchDevice}
        src={src}
        width={width}
        toggleFullScreenMode={toggleFullScreenMode}
      />
      <Tooltip tooltipContent="View in full screen" disabled={isTouchDevice}>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleFullScreenMode(true);
          }}
          className="grid h-full flex-shrink-0 place-items-center text-on-color/60 transition-colors hover:text-on-color"
          aria-label="View image in full screen"
        >
          <FullScreenOutline className="size-3" />
        </button>
      </Tooltip>
    </>
  );
}
