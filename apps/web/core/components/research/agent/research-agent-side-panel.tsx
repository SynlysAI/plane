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

  useEffect(() => {
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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
