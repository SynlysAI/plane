"use client";

import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
// components
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import type { TResearchAgentSessionApi } from "@/components/research/agent/use-research-agent-session";

type Props = {
  api: TResearchAgentSessionApi;
  variant: "page" | "panel";
  onOpenRuntime?: () => void;
};

/** 精简头部：一行上下文 + 状态徽章 + 运行详情 + 停止（仅运行中显示）。 */
export function ResearchAgentHeader({ api, variant, onOpenRuntime }: Props) {
  const { t } = useTranslation();
  const isPage = variant === "page";
  const streaming = api.session?.status === "STREAMING";

  return (
    <div
      className={`flex shrink-0 items-center justify-between gap-3 border-b border-subtle bg-surface-1 ${
        isPage ? "px-5 py-2.5" : "px-4 py-2"
      }`}
    >
      <div className="min-w-0 truncate text-11 text-secondary">
        {api.session?.project_name ?? api.session?.project ?? "-"} · {api.session?.chain_node_title ?? api.chainNodeId}
        {api.session && ` · ${t("research.agent.resource_count", { count: api.authorizedResourceCount })}`}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <ResearchStatusBadge status={api.session?.status ?? "unknown"}>
          {api.statusKey ? t(api.statusKey) : t("research.agent.no_session")}
        </ResearchStatusBadge>
        {isPage && onOpenRuntime && (
          <Button variant="secondary" size="sm" onClick={onOpenRuntime}>
            {t("research.agent.runtime_details")}
          </Button>
        )}
        {streaming && (
          <Button variant="secondary" size="sm" onClick={() => void api.stop()} disabled={api.sending}>
            {t("research.agent.stop")}
          </Button>
        )}
      </div>
    </div>
  );
}
