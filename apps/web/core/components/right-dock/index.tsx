/**
 * Global right-dock coordination for persistent Agent and ephemeral detail panels.
 */
"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "@plane/i18n";
import { Sparkles, X } from "lucide-react";
import { cn } from "@plane/utils";
import type { TAgentFocusRef } from "@/services/agent-dock";

export type TRightDockDetail = {
  id: string;
  title: string;
  focusRef?: TAgentFocusRef | null;
  onClose?: () => void;
};

type TRightDockContext = {
  registerDetail: (detail: TRightDockDetail) => void;
  unregisterDetail: (id: string) => void;
  closeActiveDetail: () => void;
  activeDetail: TRightDockDetail | null;
};

const RightDockContext = createContext<TRightDockContext | null>(null);

export function RightDockProvider({ children }: { children: ReactNode }) {
  const [details, setDetails] = useState<TRightDockDetail[]>([]);

  const registerDetail = useCallback((detail: TRightDockDetail) => {
    setDetails((current) => [...current.filter((item) => item.id !== detail.id), detail]);
  }, []);

  const unregisterDetail = useCallback((id: string) => {
    setDetails((current) => current.filter((item) => item.id !== id));
  }, []);

  const activeDetail = details.at(-1) ?? null;
  const closeActiveDetail = useCallback(() => {
    details.at(-1)?.onClose?.();
    setDetails((current) => current.slice(0, -1));
  }, [details]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeActiveDetail();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [closeActiveDetail]);

  const value = useMemo(
    () => ({ registerDetail, unregisterDetail, closeActiveDetail, activeDetail }),
    [activeDetail, closeActiveDetail, registerDetail, unregisterDetail]
  );
  return <RightDockContext.Provider value={value}>{children}</RightDockContext.Provider>;
}

export function useRightDock() {
  const context = useContext(RightDockContext);
  // Standalone tests and legacy mounts may render a detail outside the global
  // shell. Keep those usable with the old fixed layer; production AIAssistantRoot
  // always supplies the coordinator.
  return context;
}

export function useRightDockState() {
  const context = useContext(RightDockContext);
  return {
    hasDetail: Boolean(context?.activeDetail),
    activeDetail: context?.activeDetail ?? null,
    focusRef: context?.activeDetail?.focusRef ?? null,
  };
}

export function RightDockPortal({
  id,
  title,
  focusRef,
  onClose,
  children,
  fallbackClassName,
}: TRightDockDetail & { children: ReactNode; fallbackClassName?: string }) {
  const { registerDetail, unregisterDetail, activeDetail } = useRightDock() ?? {};
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!registerDetail || !unregisterDetail) return;
    registerDetail({ id, title, focusRef, onClose });
    return () => unregisterDetail(id);
  }, [focusRef, id, onClose, registerDetail, title, unregisterDetail]);

  useEffect(() => {
    setContainer(document.getElementById("plane-right-detail-dock-body"));
  }, [activeDetail?.id]);

  if (!registerDetail || !unregisterDetail) {
    return (
      <aside
        className={
          fallbackClassName ??
          "fixed inset-y-0 right-0 z-30 flex w-full flex-col border-l border-subtle bg-surface-1 md:w-[420px]"
        }
      >
        {children}
      </aside>
    );
  }

  if (!container || activeDetail?.id !== id) return null;
  return createPortal(children, container);
}

export function RightDockOutlet({ compact }: { compact: boolean }) {
  const { t } = useTranslation();
  const { activeDetail, closeActiveDetail } = useRightDock() ?? {};
  if (!activeDetail) return null;
  return (
    <aside
      data-right-dock-detail={activeDetail.id}
      className={cn("@container flex h-full min-w-0 flex-col overflow-hidden border-l border-subtle bg-surface-1")}
      style={{
        flexBasis: compact ? "min(34%, 520px)" : "min(45%, 720px)",
        minWidth: "min(320px, 100%)",
      }}
    >
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-subtle px-4 py-2">
        <div className="min-w-0 grow">
          <p className="text-13 leading-tight font-medium break-words text-primary">{activeDetail.title}</p>
          <p className="text-10 text-tertiary">{t("aiAssistant.detail_dock")}</p>
        </div>
        <button
          type="button"
          onClick={closeActiveDetail}
          aria-label={t("aiAssistant.close_detail")}
          className="flex size-7 items-center justify-center rounded-md text-secondary transition hover:bg-surface-2 hover:text-primary"
        >
          <X className="size-3.5" />
        </button>
      </header>
      <div id="plane-right-detail-dock-body" className="min-h-0 flex-1 overflow-hidden" />
    </aside>
  );
}

export function RightDockShell({
  children,
  agentPanel,
  agentOpen,
  agentDocked = false,
  agentWidth = 420,
  agentFloatingFull = false,
  launcherVisible = true,
  onOpenAgent,
}: {
  children: ReactNode;
  agentPanel: ReactNode;
  agentOpen: boolean;
  agentDocked?: boolean;
  agentWidth?: number;
  agentFloatingFull?: boolean;
  launcherVisible?: boolean;
  onOpenAgent: () => void;
}) {
  const { t } = useTranslation();
  const { hasDetail } = useRightDockState();

  const showDockedAgent = agentDocked && agentOpen;
  const showFloatingAgent = agentOpen && !agentDocked;
  const showRail = hasDetail && !agentOpen;
  const showLauncher = launcherVisible && !agentOpen && !hasDetail;

  return (
    <div className="relative flex size-full min-h-0 min-w-0 flex-1 items-stretch overflow-hidden">
      <div
        data-right-dock-workspace
        className="relative flex min-h-0 min-w-0 flex-col overflow-hidden"
        style={{ flexBasis: "min(320px, 100%)", flexGrow: 1, flexShrink: 0 }}
      >
        {children}
      </div>
      <RightDockOutlet compact={showDockedAgent} />
      <div
        data-right-dock-agent
        aria-hidden={!agentOpen}
        className={
          showDockedAgent
            ? "flex h-full min-h-0 min-w-0"
            : showFloatingAgent
              ? "fixed inset-y-0 right-0 z-40 flex h-full min-h-0 min-w-0"
              : "hidden"
        }
        style={
          showDockedAgent
            ? {
                flexBasis: `${agentWidth}px`,
                flexGrow: 0,
                flexShrink: 1,
                minWidth: "min(320px, 100%)",
              }
            : showFloatingAgent
              ? {
                  width: agentFloatingFull ? "100%" : `min(${agentWidth}px, 100%)`,
                  minWidth: "min(320px, 100%)",
                }
              : undefined
        }
      >
        {agentPanel}
      </div>
      {showLauncher ? (
        <button
          type="button"
          data-right-dock-agent-launcher
          onClick={onOpenAgent}
          aria-label={t("aiAssistant.open")}
          title={t("aiAssistant.open")}
          className="fixed top-1/2 right-5 z-40 flex size-11 -translate-y-1/2 items-center justify-center rounded-[6px] border border-subtle bg-surface-1 text-primary transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-strong"
        >
          <Sparkles className="size-[18px]" />
        </button>
      ) : null}
      {showRail ? (
        <nav
          aria-label={t("aiAssistant.right_dock")}
          data-right-dock-rail
          className="flex h-full w-11 shrink-0 flex-col items-center justify-start gap-1 border-l border-subtle bg-surface-2 py-2"
        >
          <button
            type="button"
            onClick={() => {
              onOpenAgent();
            }}
            aria-pressed={showDockedAgent}
            aria-label={t("aiAssistant.open")}
            title={t("aiAssistant.open")}
            className="flex size-8 items-center justify-center rounded-md text-secondary transition hover:bg-surface-1 hover:text-primary"
          >
            <Sparkles className="size-4" />
          </button>
        </nav>
      ) : null}
    </div>
  );
}
