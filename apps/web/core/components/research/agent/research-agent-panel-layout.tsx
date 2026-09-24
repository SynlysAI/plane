"use client";

import { useTranslation } from "@plane/i18n";
// components
import { ResearchAgentConversation } from "@/components/research/agent/research-agent-conversation";
import { ResearchAgentRuntime } from "@/components/research/agent/research-agent-runtime";
import type { TResearchAgentSessionApi } from "@/components/research/agent/use-research-agent-session";

type Props = {
  api: TResearchAgentSessionApi;
};

/** Condensed side-panel layout: assembly and runtime stay collapsed but reachable. */
export function ResearchAgentPanelLayout({ api }: Props) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ResearchAgentConversation api={api} />
      <details className="border-t border-subtle">
        <summary className="cursor-pointer list-none px-4 py-2 text-11 text-secondary hover:text-primary">
          {t("research.agent.runtime_details")}
        </summary>
        <div className="max-h-72 overflow-y-auto border-t border-subtle">
          <section className="border-b border-subtle p-4">
            <div className="grid grid-cols-1 gap-3">
              <div>
                <h3 className="text-11 font-semibold text-secondary">{t("research.agent.assembly_available")}</h3>
                <ul className="mt-2 space-y-1 text-11 text-secondary" role="list">
                  <li>{api.session?.assembly.persona ?? "-"}</li>
                  {(api.session?.assembly.allowed_tools ?? []).map((tool) => (
                    <li key={tool}>{tool}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-11 font-semibold text-secondary">{t("research.agent.assembly_confirmation")}</h3>
                <p className="mt-2 text-11 text-secondary">
                  {api.session?.assembly.policy_id
                    ? t("research.agent.policy_confirmation", { policy: api.session.assembly.policy_id })
                    : t("research.agent.assembly_no_confirmation")}
                </p>
              </div>
              <div>
                <h3 className="text-11 font-semibold text-secondary">{t("research.agent.assembly_unavailable")}</h3>
                <ul className="mt-2 space-y-1 text-11 text-secondary" role="list">
                  {(api.session?.assembly.unavailable_reasons ?? []).map((reason) => (
                    <li key={reason}>{t(`research.agent.reasons.${reason}`)}</li>
                  ))}
                  {!(api.session?.assembly.unavailable_reasons ?? []).length && (
                    <li>{t("research.agent.assembly_all_available")}</li>
                  )}
                </ul>
              </div>
            </div>
          </section>
          <ResearchAgentRuntime api={api} />
        </div>
      </details>
    </div>
  );
}
