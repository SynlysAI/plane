/**
 * Global right-dock coordination for persistent Agent and ephemeral detail panels.
 */
"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "@plane/i18n";
import { FileText, Sparkles, X } from "lucide-react";
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

export function RightDockOutlet({ visible }: { visible: boolean }) {
  const { activeDetail, closeActiveDetail } = useRightDock() ?? {};
  if (!activeDetail) return null;
  return (
    <aside
      data-right-dock-detail={activeDetail.id}
      className={cn(
        "h-full min-w-0 flex-col overflow-hidden border-l border-subtle bg-surface-1",
        visible ? "flex" : "hidden"
      )}
      style={{ width: "clamp(360px, 32vw, 560px)" }}
    >
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-subtle px-4">
        <div className="min-w-0">
          <p className="truncate text-13 leading-tight font-medium text-primary">{activeDetail.title}</p>
          <p className="text-10 text-tertiary">详情停靠</p>
        </div>
        <button
          type="button"
          onClick={closeActiveDetail}
          aria-label="关闭详情"
          className="flex size-7 items-center justify-center rounded-md text-secondary transition hover:bg-surface-2 hover:text-primary"
        >
          <X className="size-3.5" />
        </button>
      </header>
      <div id="plane-right-detail-dock-body" className="min-h-0 flex-1 overflow-hidden" />
    </aside>
  );
}

function useMediaWidth(width: number) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      setMatches(window.innerWidth >= width);
      return;
    }
    const query = window.matchMedia(`(min-width: ${width}px)`);
    const update = () => setMatches(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [width]);
  return matches;
}

export function RightDockShell({
  children,
  agentPanel,
  agentOpen,
  onOpenAgent,
}: {
  children: ReactNode;
  agentPanel: ReactNode;
  agentOpen: boolean;
  onOpenAgent: () => void;
}) {
  const { t } = useTranslation();
  const { hasDetail } = useRightDockState();
  const wide = useMediaWidth(1440);
  const [preferred, setPreferred] = useState<"agent" | "detail">("agent");

  useEffect(() => {
    if (hasDetail) setPreferred("detail");
  }, [hasDetail]);

  const showDetail = hasDetail && (wide || preferred === "detail");
  const showAgent = agentOpen && (wide || preferred === "agent");

  return (
    <div className="relative flex size-full min-h-0 min-w-0 flex-1 items-stretch overflow-hidden">
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</main>
      <RightDockOutlet visible={showDetail} />
      {showAgent ? (
        <div data-right-dock-agent className="flex h-full min-h-0">
          {agentPanel}
        </div>
      ) : null}
      <nav
        aria-label="右侧停靠"
        data-right-dock-rail
        className="flex h-full w-11 shrink-0 flex-col items-center justify-start gap-1 border-l border-subtle bg-surface-2 py-2"
      >
        <button
          type="button"
          onClick={() => {
            setPreferred("agent");
            onOpenAgent();
          }}
          aria-pressed={showAgent}
          aria-label={t("aiAssistant.open")}
          title={t("aiAssistant.open")}
          className="flex size-8 items-center justify-center rounded-md text-secondary transition hover:bg-surface-1 hover:text-primary"
        >
          <Sparkles className="size-4" />
        </button>
        {hasDetail ? (
          <button
            type="button"
            onClick={() => setPreferred("detail")}
            aria-pressed={showDetail}
            aria-label="任务详情"
            title="任务详情"
            className="flex size-8 items-center justify-center rounded-md text-secondary transition hover:bg-surface-1 hover:text-primary"
          >
            <FileText className="size-4" />
          </button>
        ) : null}
      </nav>
    </div>
  );
}
