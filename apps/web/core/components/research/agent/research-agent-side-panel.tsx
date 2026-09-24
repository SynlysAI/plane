/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { IconButton } from "@plane/propel/icon-button";
// components
import { ResearchAgentPlugin } from "@/components/research/agent/research-agent-plugin";

type Props = {
  workspaceSlug: string;
  chainNodeId: string;
  onClose: () => void;
};

/** Right-side agent drawer: inherits the current chain-node context without leaving the page. */
export function ResearchAgentSidePanel({ workspaceSlug, chainNodeId, onClose }: Props) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const activeIndex = active instanceof HTMLElement ? Array.prototype.indexOf.call(focusable, active) : -1;
      const next = event.shiftKey
        ? activeIndex <= 0
          ? last
          : focusable[activeIndex - 1]
        : activeIndex === -1 || activeIndex === focusable.length - 1
          ? first
          : focusable[activeIndex + 1];
      event.preventDefault();
      next.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, [onClose]);

  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        aria-label={t("research.agent.close_drawer")}
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/20"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("research.agent.title")}
        tabIndex={-1}
        className="fixed top-0 right-0 z-50 flex h-full w-[400px] shrink-0 flex-col border-l border-subtle bg-surface-1 outline-none"
      >
        <div className="flex items-center justify-between bg-surface-2 px-4 py-2.5">
          <span className="text-13 font-semibold text-primary">{t("research.agent.title")}</span>
          <IconButton
            variant="ghost"
            size="sm"
            icon={X}
            onClick={onClose}
            aria-label={t("research.agent.close_drawer")}
          />
        </div>
        <div className="min-h-0 flex-1">
          <ResearchAgentPlugin workspaceSlug={workspaceSlug} chainNodeId={chainNodeId} variant="panel" />
        </div>
      </div>
    </>
  );
}
