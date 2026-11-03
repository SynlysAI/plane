/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { type ReactNode, useEffect, useMemo } from "react";
import { useParams } from "next/navigation";
import { useTranslation } from "@plane/i18n";
import useSWR from "swr";
import { Sparkles } from "lucide-react";
import { Tooltip } from "@makeplane/propel/components/tooltip";
// components
import { AIAssistantPanel } from "./ai-assistant-panel";
// helpers
import { AssistantService, type TAssistantStatus } from "@/services/assistant";
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
export const AIAssistantRoot = observer(function AIAssistantRoot({ children }: Props) {
  const { t } = useTranslation();
  const params = useParams();
  const workspaceSlug = params?.workspaceSlug?.toString();
  const assistantStore = useAIAssistant();
  const { data: currentUser } = useUser();

  const {
    data: status,
    error,
    mutate,
  } = useSWR(
    workspaceSlug ? `AI_ASSISTANT_STATUS_${workspaceSlug}` : null,
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
    if (workspaceSlug && currentUser?.id) assistantStore.hydrate(workspaceSlug, currentUser.id);
  }, [workspaceSlug, assistantStore, currentUser?.id]);

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
    <div className="relative flex size-full min-h-0 min-w-0 flex-1 items-stretch overflow-hidden">
      <div className="relative flex size-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
      {resolvedStatus && !assistantStore.isOpen && (
        <div className="fixed top-1/2 right-5 z-40 -translate-y-1/2">
          <Tooltip label={t("aiAssistant.open")} side="left">
            <button
              type="button"
              onClick={() => assistantStore.open()}
              aria-label={t("aiAssistant.open")}
              className="flex size-11 items-center justify-center rounded-[6px] border border-subtle bg-surface-1 text-primary transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-strong"
            >
              <Sparkles className="size-[18px]" />
            </button>
          </Tooltip>
        </div>
      )}
      <AIAssistantPanel
        workspaceSlug={workspaceSlug}
        statusState={resolvedStatus?.state ?? "loading"}
        onRetryStatus={() => void mutate()}
      />
    </div>
  );
});
