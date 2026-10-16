/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useEffect } from "react";
import { useParams } from "next/navigation";
import { useTranslation } from "@plane/i18n";
import useSWR from "swr";
import { Sparkles } from "lucide-react";
import { Tooltip } from "@makeplane/propel/components/tooltip";
// components
import { AIAssistantPanel } from "./ai-assistant-panel";
// helpers
import { AssistantService } from "@/services/assistant";
// store
import { useAIAssistant } from "@/hooks/store/use-ai-assistant";

const assistantService = new AssistantService();

/**
 * Workspace-wide assistant mount: floating launcher, Cmd/Ctrl+J shortcut and
 * the side panel. Hidden entirely while the workspace has no usable Synlora
 * connection (status endpoint drives availability).
 */
export const AIAssistantRoot = observer(function AIAssistantRoot() {
  const { t } = useTranslation();
  const params = useParams();
  const workspaceSlug = params?.workspaceSlug?.toString();
  const assistantStore = useAIAssistant();

  const { data: status } = useSWR(
    workspaceSlug ? `AI_ASSISTANT_STATUS_${workspaceSlug}` : null,
    workspaceSlug ? () => assistantService.getStatus(workspaceSlug) : null
  );

  useEffect(() => {
    if (status) assistantStore.setStatus({ enabled: status.enabled, ready: status.ready });
  }, [status, assistantStore]);

  useEffect(() => {
    if (workspaceSlug) assistantStore.hydrate(workspaceSlug);
  }, [workspaceSlug, assistantStore]);

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

  if (!workspaceSlug || !status?.enabled) return null;

  return (
    <>
      {!assistantStore.isOpen && (
        <div className="fixed right-5 bottom-5 z-40">
          <Tooltip label={t("aiAssistant.open")} side="left">
            <button
              type="button"
              onClick={() => assistantStore.open()}
              aria-label={t("aiAssistant.open")}
              className="shadow-lg flex size-11 items-center justify-center rounded-full border border-subtle bg-surface-1 text-primary transition hover:bg-surface-2"
            >
              <Sparkles className="size-5" />
            </button>
          </Tooltip>
        </div>
      )}
      <AIAssistantPanel workspaceSlug={workspaceSlug} />
    </>
  );
});
