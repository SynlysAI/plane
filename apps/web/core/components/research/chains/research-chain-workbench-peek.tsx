"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";

export type TWorkbenchRecordPeek = "evidence" | "snapshots" | "trace" | "empty";

export type TWorkbenchPeek =
  | { kind: TWorkbenchRecordPeek }
  | { kind: "task"; taskId: string }
  | { kind: "create" }
  | null;

type TWorkbenchPeekContext = {
  peek: TWorkbenchPeek;
  openRecord: (kind: TWorkbenchRecordPeek) => void;
  openTask: (taskId: string) => void;
  openCreate: () => void;
  close: () => void;
};

const WorkbenchPeekContext = createContext<TWorkbenchPeekContext | null>(null);

/**
 * 让证据 Peek 和任务 Peek 共用一个开关，保证同一时间只打开一层。
 */
export function ResearchChainWorkbenchPeekProvider({ children }: { children: ReactNode }) {
  const [peek, setPeek] = useState<TWorkbenchPeek>(null);
  const value = useMemo<TWorkbenchPeekContext>(
    () => ({
      peek,
      openRecord: (kind) => setPeek((current) => (current?.kind === kind ? null : { kind })),
      openTask: (taskId) => setPeek({ kind: "task", taskId }),
      openCreate: () => setPeek({ kind: "create" }),
      close: () => setPeek(null),
    }),
    [peek]
  );
  return <WorkbenchPeekContext.Provider value={value}>{children}</WorkbenchPeekContext.Provider>;
}

/** 读取工作台 Peek。组件单独渲染时返回 null，由调用方自行管理。 */
export function useResearchChainWorkbenchPeek() {
  return useContext(WorkbenchPeekContext);
}

export type TWorkbenchPeekMode = "side" | "modal" | "full";

type Props = {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** narrow 保持证据 Peek 宽度；wide 对齐行政工作项的半屏侧栏。 */
  size?: "narrow" | "wide";
  mode?: TWorkbenchPeekMode;
  header?: ReactNode;
  bodyClassName?: string;
};

/**
 * 在工作台右侧覆盖一个详情层，不挤压阶段流程。
 *
 * Args:
 *   title: 弹出层标题，同时作为无障碍名称。
 *   onClose: 关闭回调。Escape 和层外点击会触发。
 *   children: 当前模式的正文。
 *   size: narrow 为证据层宽度，wide 为行政工作项同宽的半屏。
 *   mode: 侧边、模态或全屏。仅 wide 会改变框体。
 *   header: 自定义顶栏。缺省时使用标题和关闭文字。
 *   bodyClassName: 正文滚动区的样式。缺省保留原内边距。
 */
export function ResearchChainWorkbenchPeek({
  title,
  onClose,
  children,
  size = "narrow",
  mode = "side",
  header,
  bodyClassName,
}: Props) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || panelRef.current?.contains(target)) return;
      if (
        target instanceof Element &&
        target.closest("[data-peek-trigger], [data-reason-dialog], [data-prevent-outside-click]")
      )
        return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [onClose]);

  const wide = size === "wide";
  const frameClass = wide
    ? cn(
        "fixed z-30 flex flex-col overflow-hidden border border-subtle bg-surface-1 shadow-[0_8px_24px_rgba(37,37,34,0.08)]",
        mode === "side" && "inset-y-0 right-0 w-full border-y-0 border-r-0 md:w-1/2",
        mode === "modal" && "top-[8.33%] left-[8.33%] h-5/6 w-5/6 rounded-sm",
        mode === "full" && "inset-4 rounded-sm"
      )
    : "border-subtle bg-surface-1 fixed inset-y-0 right-0 z-30 flex w-full flex-col border-l shadow-[0_8px_24px_rgba(37,37,34,0.08)] md:w-[420px]";

  return (
    <>
      {mode === "side" ? (
        <div className="fixed inset-0 z-30 bg-backdrop md:hidden" />
      ) : (
        <div className="fixed inset-0 z-20 bg-backdrop" />
      )}
      <aside ref={panelRef} role="dialog" aria-modal="false" aria-label={title} className={frameClass}>
        {header ?? (
          <header className="flex items-center justify-between gap-3 border-b border-subtle px-4 py-3">
            <h3 className="truncate text-14 font-semibold text-primary">{title}</h3>
            <button type="button" className="text-12 text-secondary hover:text-primary" onClick={onClose}>
              {t("research.chains.workflow.close_peek")}
            </button>
          </header>
        )}
        <div className={bodyClassName ?? "min-h-0 flex-1 overflow-y-auto px-4 py-4"}>{children}</div>
      </aside>
    </>
  );
}
