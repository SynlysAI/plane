"use client";

import { useTranslation } from "@plane/i18n";
// components
import { ResearchAgentConversation } from "@/components/research/agent/research-agent-conversation";
import { ResearchAgentRuntime } from "@/components/research/agent/research-agent-runtime";
import type { TResearchAgentSessionApi } from "@/components/research/agent/use-research-agent-session";

type Props = {
  api: TResearchAgentSessionApi;
  runtimeOpen: boolean;
  onCloseRuntime: () => void;
};

/** 全页聊天式布局：居中对话流为主，装配与运行时信息收进「运行详情」抽屉。 */
export function ResearchAgentPageLayout({ api, runtimeOpen, onCloseRuntime }: Props) {
  const { t } = useTranslation();

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ResearchAgentConversation api={api} />
      </div>
      {runtimeOpen && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-label={t("research.agent.close_runtime")}
            onClick={onCloseRuntime}
            className="fixed inset-0 z-40 bg-black/20"
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={t("research.agent.runtime_details")}
            className="fixed top-0 right-0 z-50 flex h-full w-full max-w-md flex-col border-l border-subtle bg-surface-1"
          >
            <div className="flex items-center justify-between border-b border-subtle px-4 py-3">
              <h3 className="text-13 font-semibold text-primary">{t("research.agent.runtime_details")}</h3>
              <button
                type="button"
                onClick={onCloseRuntime}
                className="rounded-md px-2 py-1 text-12 text-secondary hover:bg-surface-2"
              >
                {t("research.agent.close_runtime")}
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <ResearchAgentRuntime api={api} />
            </div>
          </aside>
        </>
      )}
    </>
  );
}
