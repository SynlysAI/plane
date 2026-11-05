/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { useParams } from "next/navigation";
import useSWR from "swr";
// components
import { AIAssistantPanel } from "./ai-assistant-panel";
// helpers
import { AssistantService, type TAssistantStatus } from "@/services/assistant";
import { clearLaunchHistoryScopes } from "@/components/assistant/lib/launch-history";
import { BACKEND_AVAILABILITY_CHANGED } from "./lib/backend-availability";
import { RightDockProvider, RightDockShell, useRightDockState } from "@/components/right-dock";
import { useAgentDockDesktop } from "@/hooks/use-agent-dock-desktop";
// store
import { useUser } from "@/hooks/store/user";
import { useAIAssistant } from "@/hooks/store/use-ai-assistant";

const assistantService = new AssistantService();

/** Normalize legacy status payloads while preserving the new state contract. */
function normalizeAssistantStatus(status: TAssistantStatus | undefined): TAssistantStatus | null {
  if (status?.state) return status;
  if (!status) return null;
  const state = status.enabled
    ? status.ready
      ? "ready"
      : "service_unavailable"
    : status.credential_mode === "PERSONAL"
      ? "personal_credential_required"
      : "not_configured";
  return { ...status, state };
}

type Props = {
  children: ReactNode;
};

/**
 * Workspace-wide assistant mount. The shell keeps the page outlet at a stable
 * height; status only changes assistant availability, never page structure.
 */
const AIAssistantRootContent = observer(function AIAssistantRootContent({ children }: Props) {
  const params = useParams();
  const workspaceSlug = params?.workspaceSlug?.toString();
  const assistantStore = useAIAssistant();
  const { data: currentUser } = useUser();
  const { hasDetail } = useRightDockState();
  const ownerScopeRef = useRef<{ workspaceSlug: string; ownerKey: string | null } | null>(null);
  const isDesktop = useAgentDockDesktop();

  const {
    data: status,
    error,
    mutate,
  } = useSWR(
    workspaceSlug && currentUser?.id ? `AI_ASSISTANT_STATUS_${workspaceSlug}_${currentUser.id}` : null,
    workspaceSlug ? () => assistantService.getStatus(workspaceSlug) : null,
    { shouldRetryOnError: false }
  );

  const resolvedStatus = useMemo(
    () =>
      normalizeAssistantStatus(status) ??
      (error
        ? ({
            enabled: false,
            ready: false,
            credential_mode: "SHARED",
            state: "service_unavailable",
          } satisfies TAssistantStatus)
        : null),
    [error, status]
  );

  useEffect(() => {
    if (resolvedStatus) assistantStore.setStatus(resolvedStatus);
  }, [assistantStore, resolvedStatus]);

  useEffect(() => {
    if (!workspaceSlug) return;
    const invalidate = (event: Event) => {
      const changedWorkspace = (event as CustomEvent<{ workspaceSlug?: string }>).detail?.workspaceSlug;
      if (!changedWorkspace || changedWorkspace === workspaceSlug) void mutate();
    };
    window.addEventListener(BACKEND_AVAILABILITY_CHANGED, invalidate);
    return () => window.removeEventListener(BACKEND_AVAILABILITY_CHANGED, invalidate);
  }, [mutate, workspaceSlug]);

  useEffect(() => {
    if (assistantStore.isOpen) void mutate();
  }, [assistantStore.isOpen, mutate]);

  useEffect(() => {
    if (workspaceSlug && currentUser?.id) assistantStore.hydrate(workspaceSlug, currentUser.id);
  }, [workspaceSlug, assistantStore, currentUser?.id]);

  useEffect(() => {
    if (!workspaceSlug) return;
    const ownerKey = currentUser?.id ?? null;
    const previousScope = ownerScopeRef.current;
    if (
      previousScope !== null &&
      previousScope.ownerKey !== ownerKey &&
      (previousScope.workspaceSlug !== workspaceSlug || previousScope.ownerKey !== ownerKey)
    ) {
      clearLaunchHistoryScopes(previousScope, { workspaceSlug, ownerKey });
    }
    ownerScopeRef.current = { workspaceSlug, ownerKey };
  }, [currentUser?.id, workspaceSlug]);

  useEffect(() => {
    if (!hasDetail || !isDesktop) return;
    if (assistantStore.dockMode === "floating") assistantStore.setDockMode("docked");
    if (assistantStore.expanded) assistantStore.toggleExpanded(false);
  }, [assistantStore, hasDetail, isDesktop]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !hasDetail) assistantStore.close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [assistantStore, hasDetail]);

  // document-level capture: works while any input (including the composer) is focused
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        assistantStore.toggle();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [assistantStore]);

  if (!workspaceSlug) return <>{children}</>;

  return (
    <RightDockShell
      agentOpen={assistantStore.isOpen}
      agentDocked={assistantStore.dockMode === "docked" && isDesktop && !assistantStore.expanded}
      agentWidth={assistantStore.width}
      agentFloatingFull={assistantStore.expanded}
      launcherVisible={resolvedStatus !== null}
      onOpenAgent={() => assistantStore.open()}
      agentPanel={
        <AIAssistantPanel
          workspaceSlug={workspaceSlug}
          statusState={resolvedStatus?.state ?? "loading"}
          portalUrl={resolvedStatus?.portal_url ?? null}
          onRetryStatus={() => void mutate()}
        />
      }
    >
      {children}
    </RightDockShell>
  );
});

export const AIAssistantRoot = observer(function AIAssistantRoot(props: Props) {
  return (
    <RightDockProvider>
      <AIAssistantRootContent {...props} />
    </RightDockProvider>
  );
});
