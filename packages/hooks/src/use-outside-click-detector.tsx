/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type React from "react";
import { useEffect } from "react";

const INSIDE_MENU_SELECTOR = "[data-prevent-outside-click], [role='listbox'], [role='option']";

/** 菜单项、传送到卡片外的列表，以及显式标记的层，都不算外部点击。 */
export function isDropdownMenuTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(INSIDE_MENU_SELECTOR));
}

export const useOutsideClickDetector = (
  ref: React.RefObject<HTMLElement | null> | any,
  callback: () => void,
  useCapture = false
) => {
  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!ref.current || !(target instanceof Node)) return;
      if (ref.current.contains(target)) return;
      if (isDropdownMenuTarget(target)) return;
      // 选项的按下处理先提交值，再允许外层在这一拍之后关闭。
      window.setTimeout(() => callback(), 0);
    };

    document.addEventListener("mousedown", handleClick, useCapture);
    return () => {
      document.removeEventListener("mousedown", handleClick, useCapture);
    };
  });
};
