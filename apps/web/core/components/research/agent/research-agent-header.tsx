"use client";

import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
// components
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import { formatResearchDateTime } from "@/components/research/common/research-format";
import type { TResearchAgentSessionApi } from "@/components/research/agent/use-research-agent-session";

type Props = {
  api: TResearchAgentSessionApi;
  variant: "page" | "panel";
};

/** Fixed context header shared by the workbench and the side panel. */
export function ResearchAgentHeader({ api, variant }: Props) {
  const { t, currentLocale } = useTranslation();
  const isPage = variant === "page";

  return (
    <div
      className={`sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-subtle bg-surface-1 ${
        isPage ? "px-5 py-3" : "px-4 py-2.5"
      }`}
    >
      <div className="min-w-0">
        <p className="text-13 font-semibold text-primary">{t("research.agent.context_summary")}</p>
        <p className="mt-1 truncate text-11 text-secondary">
          {api.session?.project_name ?? api.session?.project ?? "-"} ·{" "}
          {api.session?.chain_node_title ?? api.chainNodeId}
        </p>
        <p className="mt-0.5 truncate text-11 text-tertiary">
          {t("research.agent.resource_count", { count: api.authorizedResourceCount })}
          {api.session?.context_expires_at &&
            ` · ${t("research.agent.context_expires", {
              time: formatResearchDateTime(api.session.context_expires_at, currentLocale),
            })}`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ResearchStatusBadge status={api.session?.status ?? "unknown"}>
          {api.statusKey ? t(api.statusKey) : t("research.agent.no_session")}
        </ResearchStatusBadge>
        {isPage && (
          <span className="rounded-md border border-subtle px-2 py-1 text-11 text-tertiary tabular-nums">
            {t("research.agent.last_seq", { seq: api.latestSeq })}
          </span>
        )}
        {api.activeApproval && (
          <Button variant="primary" size="base" onClick={() => api.setApprovalFor(api.activeApproval)}>
            {t("research.agent.open_approval")}
          </Button>
        )}
        {isPage && (
          <Button variant="secondary" size="base" onClick={() => api.setArtifactDrawerOpen(true)}>
            {t("research.agent.open_artifact")}
          </Button>
        )}
        <Button
          variant="secondary"
          size="base"
          onClick={() => void api.reconnect()}
          disabled={!api.session || api.reconnecting}
        >
          {t("research.agent.reconnect")}
        </Button>
        {isPage && (api.state === "closed" || api.state === "error") && (
          <Button variant="secondary" size="base" onClick={() => window.location.reload()}>
            {t("research.agent.reload_context")}
          </Button>
        )}
        <Button
          variant="secondary"
          size="base"
          onClick={() => void api.stop()}
          disabled={!api.session || api.session.status === "CLOSED" || api.sending}
        >
          {t("research.agent.stop")}
        </Button>
        {isPage && (
          <Button
            variant="secondary"
            size="base"
            onClick={() => void api.close()}
            disabled={!api.session || api.session.status === "CLOSED"}
          >
            {t("research.agent.close")}
          </Button>
        )}
      </div>
    </div>
  );
}
