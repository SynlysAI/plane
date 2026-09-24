"use client";

import { useTranslation } from "@plane/i18n";
// components
import { ResearchAgentConversation } from "@/components/research/agent/research-agent-conversation";
import { ResearchAgentRuntime } from "@/components/research/agent/research-agent-runtime";
import type { TResearchAgentSessionApi } from "@/components/research/agent/use-research-agent-session";

type Props = {
  api: TResearchAgentSessionApi;
};

/** Full-page Agent workbench: assembly summary, conversation and runtime side column. */
export function ResearchAgentPageLayout({ api }: Props) {
  const { t } = useTranslation();

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_440px]">
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-subtle px-5 py-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <section>
              <h3 className="text-11 font-semibold text-secondary">{t("research.agent.assembly_available")}</h3>
              <ul className="mt-2 space-y-1 text-11 text-secondary" role="list">
                <li>{api.session?.assembly.persona ?? "-"}</li>
                {(api.session?.assembly.allowed_tools ?? []).map((tool) => (
                  <li key={tool}>{tool}</li>
                ))}
              </ul>
            </section>
            <section>
              <h3 className="text-11 font-semibold text-secondary">{t("research.agent.assembly_confirmation")}</h3>
              <p className="mt-2 text-11 text-secondary">
                {api.session?.assembly.policy_id
                  ? t("research.agent.policy_confirmation", { policy: api.session.assembly.policy_id })
                  : t("research.agent.assembly_no_confirmation")}
              </p>
            </section>
            <section>
              <h3 className="text-11 font-semibold text-secondary">{t("research.agent.assembly_unavailable")}</h3>
              <ul className="mt-2 space-y-1 text-11 text-secondary" role="list">
                {(api.session?.assembly.unavailable_reasons ?? []).map((reason) => (
                  <li key={reason}>{t(`research.agent.reasons.${reason}`)}</li>
                ))}
                {!(api.session?.assembly.unavailable_reasons ?? []).length && (
                  <li>{t("research.agent.assembly_all_available")}</li>
                )}
              </ul>
            </section>
          </div>
        </div>
        <ResearchAgentConversation api={api} />
      </div>
      <aside className="min-h-0 border-subtle xl:border-l">
        <ResearchAgentRuntime api={api} />
      </aside>
    </div>
  );
}
