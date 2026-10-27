/** Notify todo views that a server-side todo projection has changed. */
export function notifyWorkspaceTodosUpdated(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("workspace-todos-updated"));
}

/** 订阅待办刷新事件，并将短时间内的连续动作合并成一次刷新。
 *
 * Args:
 *   listener: 实际执行刷新的回调。
 *   delay: 合并窗口毫秒数。
 *
 * Returns:
 *   清理事件监听与待执行定时器的函数。
 */
export function subscribeWorkspaceTodosUpdated(listener: () => void, delay = 300): () => void {
  if (typeof window === "undefined") return () => undefined;
  let timer: number | undefined;
  const handleEvent = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(listener, delay);
  };
  window.addEventListener("workspace-todos-updated", handleEvent);
  return () => {
    window.clearTimeout(timer);
    window.removeEventListener("workspace-todos-updated", handleEvent);
  };
}
