"use client";

import type React from "react";
import { useCallback } from "react";
import { useOutsideClickDetector } from "@plane/hooks";

type TUseTransientMenuArgs<TElement extends HTMLElement> = {
  ref: React.RefObject<TElement | null>;
  isOpen: boolean;
  onClose: () => void;
};

/**
 * 为手写的瞬时菜单提供外部点击和 Escape 取消能力。
 *
 * Args:
 *   ref: 包含触发器和浮层的容器引用。
 *   isOpen: 菜单当前是否打开。
 *   onClose: 取消菜单时执行的关闭回调。
 *
 * Returns:
 *   close 方法以及需要挂到容器上的 Escape 键盘处理函数。
 */
export function useTransientMenu<TElement extends HTMLElement>({
  ref,
  isOpen,
  onClose,
}: TUseTransientMenuArgs<TElement>) {
  const close = useCallback(() => {
    if (isOpen) onClose();
  }, [isOpen, onClose]);

  useOutsideClickDetector(ref, close);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<TElement>) => {
      if (!isOpen || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    },
    [isOpen, onClose]
  );

  return { close, handleKeyDown };
}
