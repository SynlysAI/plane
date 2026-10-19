/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
// hooks
import { usePlatformOS } from "../../hooks/use-platform-os";
// components
import { ContextMenuItem } from "./item";

export type TContextMenuItem = {
  key: string;
  customContent?: React.ReactNode;
  title?: string;
  description?: string;
  icon?: React.FC<any>;
  action: () => void;
  shouldRender?: boolean;
  closeOnClick?: boolean;
  disabled?: boolean;
  className?: string;
  iconClassName?: string;
  nestedMenuItems?: TContextMenuItem[];
};

// Portal component for nested menus
interface PortalProps {
  children: React.ReactNode;
  container?: Element | null;
}

export function Portal({ children, container }: PortalProps) {
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  if (!mounted) {
    return null;
  }

  const targetContainer = container || document.body;
  return ReactDOM.createPortal(children, targetContainer);
}

// Context for managing nested menus
export const ContextMenuContext = React.createContext<{
  closeAllSubmenus: () => void;
  registerSubmenu: (closeSubmenu: () => void) => () => void;
  portalContainer?: Element | null;
} | null>(null);

type ContextMenuProps = {
  parentRef: React.RefObject<HTMLElement | null>;
  items: TContextMenuItem[];
  portalContainer?: Element | null;
  ariaLabel?: string;
};

function ContextMenuWithoutPortal(props: ContextMenuProps) {
  const { parentRef, items, portalContainer, ariaLabel } = props;
  // states
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({
    x: 0,
    y: 0,
  });
  const [activeItemIndex, setActiveItemIndex] = useState<number>(0);
  // refs
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const submenuClosersRef = useRef<Set<() => void>>(new Set());
  // derived values
  const renderedItems = items.filter((item) => item.shouldRender !== false);
  const { isMobile } = usePlatformOS();

  const closeAllSubmenus = React.useCallback(() => {
    submenuClosersRef.current.forEach((closeSubmenu) => closeSubmenu());
  }, []);

  const registerSubmenu = React.useCallback((closeSubmenu: () => void) => {
    submenuClosersRef.current.add(closeSubmenu);
    return () => {
      submenuClosersRef.current.delete(closeSubmenu);
    };
  }, []);

  const contextValue = useMemo(
    () => ({ closeAllSubmenus, registerSubmenu, portalContainer }),
    [closeAllSubmenus, registerSubmenu, portalContainer]
  );

  const handleClose = useCallback(() => {
    closeAllSubmenus();
    setIsOpen(false);
    setActiveItemIndex(0);
  }, [closeAllSubmenus]);

  // calculate position of context menu
  useEffect(() => {
    const parentElement = parentRef.current;
    if (!parentElement) return;

    const handleContextMenu = (e: MouseEvent) => {
      if (isMobile || !items.some((item) => item.shouldRender !== false)) return;

      e.preventDefault();
      e.stopPropagation();

      setPosition({ x: e.clientX, y: e.clientY });
      setActiveItemIndex(0);
      setIsOpen(true);
    };

    const hideContextMenu = (e: KeyboardEvent) => {
      if (isOpen && e.key === "Escape") handleClose();
    };

    parentElement.addEventListener("contextmenu", handleContextMenu);
    window.addEventListener("keydown", hideContextMenu);

    return () => {
      parentElement.removeEventListener("contextmenu", handleContextMenu);
      window.removeEventListener("keydown", hideContextMenu);
    };
  }, [handleClose, isMobile, isOpen, items, parentRef]);

  // 菜单挂载后测量位置，关闭时不保留隐藏的可聚焦操作。
  useLayoutEffect(() => {
    const menu = contextMenuRef.current;
    if (!isOpen || !menu) return;
    const x = Math.max(8, Math.min(position.x, window.innerWidth - menu.offsetWidth - 8));
    const y = Math.max(8, Math.min(position.y, window.innerHeight - menu.offsetHeight - 8));
    if (x !== position.x || y !== position.y) setPosition({ x, y });
    menu.focus();
  }, [isOpen, position]);

  // handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen || renderedItems.length === 0) return;
      if (e.target instanceof Element && e.target.closest('[data-context-submenu="true"]')) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveItemIndex((prev) => (prev + 1) % renderedItems.length);
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveItemIndex((prev) => (prev - 1 + renderedItems.length) % renderedItems.length);
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const item = renderedItems[activeItemIndex];
        if (item && !item.disabled) {
          contextMenuRef.current?.querySelectorAll<HTMLButtonElement>(":scope > button")[activeItemIndex]?.click();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeItemIndex, isOpen, renderedItems]);

  // Custom handler for nested menu portal clicks
  React.useEffect(() => {
    const handleDocumentClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;

      // Check if the click is on a nested menu element
      const isNestedMenuClick = target.closest('[data-context-submenu="true"]');
      const isMainMenuClick = contextMenuRef.current?.contains(target);

      // Also check if the target itself has the data attribute
      const isNestedMenuElement = target.hasAttribute("data-context-submenu");

      // If it's a nested menu click, main menu click, or nested menu element, don't close
      if (isNestedMenuClick || isMainMenuClick || isNestedMenuElement) {
        return;
      }

      // If menu is open and it's an outside click, close it
      if (isOpen) {
        handleClose();
      }
    };

    if (isOpen) {
      // Use capture phase to ensure we handle the event before other handlers
      document.addEventListener("mousedown", handleDocumentClick, true);
      return () => {
        document.removeEventListener("mousedown", handleDocumentClick, true);
      };
    }
  }, [isOpen, handleClose]);

  if (!isOpen) return null;

  return (
    <div
      ref={contextMenuRef}
      tabIndex={-1}
      role="menu"
      aria-label={ariaLabel}
      className="vertical-scrollbar fixed z-30 scrollbar-sm min-w-[12rem] overflow-y-auto rounded-md border-[0.5px] border-subtle-1 bg-surface-1 px-2 py-2.5 outline-none"
      style={{
        top: position.y,
        left: position.x,
        maxHeight: "min(18rem, calc(100dvh - 16px))",
        maxWidth: "calc(100vw - 16px)",
      }}
      data-context-menu="true"
    >
      <ContextMenuContext.Provider value={contextValue}>
        {renderedItems.map((item, index) => (
          <ContextMenuItem
            key={item.key}
            handleActiveItem={() => setActiveItemIndex(index)}
            handleClose={handleClose}
            isActive={index === activeItemIndex}
            item={item}
          />
        ))}
      </ContextMenuContext.Provider>
    </div>
  );
}

export function ContextMenu(props: ContextMenuProps) {
  let contextMenu = <ContextMenuWithoutPortal {...props} />;
  const portal = document.querySelector("#context-menu-portal");
  if (portal) contextMenu = ReactDOM.createPortal(contextMenu, portal);
  return contextMenu;
}
