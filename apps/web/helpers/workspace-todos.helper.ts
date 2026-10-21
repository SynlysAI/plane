/** Notify todo views that a server-side todo projection has changed. */
export function notifyWorkspaceTodosUpdated(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("workspace-todos-updated"));
}
