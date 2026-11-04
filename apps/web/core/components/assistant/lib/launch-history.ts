/**
 * Browser-session-scoped Agent Dock launch history.
 *
 * The list intentionally survives a refresh but is cleared on owner change/logout;
 * the full durable history remains owned by Synlora.
 */

export type TAgentLaunchHistory = {
  launchId: string;
  sessionIds: string[];
};

const KEY_PREFIX = "PLANE_AGENT_DOCK_LAUNCH_HISTORY_";

function storageKey(workspaceSlug: string, ownerKey: string | null) {
  return `${KEY_PREFIX}${workspaceSlug}:${ownerKey ?? "anonymous"}`;
}

function randomId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Read this browser login's launch history, creating a launch id on first open. */
export function getLaunchHistory(workspaceSlug: string, ownerKey: string | null): TAgentLaunchHistory {
  const key = storageKey(workspaceSlug, ownerKey);
  const raw = globalThis.sessionStorage?.getItem(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<TAgentLaunchHistory>;
      const launchId = typeof parsed.launchId === "string" && parsed.launchId ? parsed.launchId : randomId("launch");
      const sessionIds = Array.isArray(parsed.sessionIds)
        ? parsed.sessionIds.filter((item): item is string => typeof item === "string" && Boolean(item))
        : [];
      return { launchId, sessionIds: [...new Set(sessionIds)].slice(-100) };
    } catch {
      // Fall through to a fresh launch batch if the cache is corrupt.
    }
  }
  const history = { launchId: randomId("launch"), sessionIds: [] };
  globalThis.sessionStorage?.setItem(key, JSON.stringify(history));
  return history;
}

/** Record a session created in this launch batch. */
export function addLaunchSession(workspaceSlug: string, ownerKey: string | null, sessionId: string) {
  const history = getLaunchHistory(workspaceSlug, ownerKey);
  history.sessionIds = [...new Set([...history.sessionIds, sessionId])].slice(-100);
  globalThis.sessionStorage?.setItem(storageKey(workspaceSlug, ownerKey), JSON.stringify(history));
  return history;
}

/** Clear the browser batch when the user or workspace scope changes. */
export function clearLaunchHistory(workspaceSlug: string, ownerKey: string | null) {
  globalThis.sessionStorage?.removeItem(storageKey(workspaceSlug, ownerKey));
}

/** Clear two explicitly known scopes during a user change or logout. */
export function clearLaunchHistoryScopes(
  previous: { workspaceSlug: string; ownerKey: string | null },
  next: { workspaceSlug: string; ownerKey: string | null }
) {
  clearLaunchHistory(previous.workspaceSlug, previous.ownerKey);
  clearLaunchHistory(next.workspaceSlug, next.ownerKey);
}
