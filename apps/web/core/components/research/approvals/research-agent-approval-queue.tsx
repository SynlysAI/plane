"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Badge } from "@plane/propel/badge";
import { Button, getButtonStyling } from "@plane/propel/button";
import { Skeleton } from "@plane/propel/skeleton";
import type { TResearchAgentApproval } from "@plane/types";
// services
import { ResearchAgentService, type TAgentApprovalDecision } from "@/services/research/agent.service";

const agentService = new ResearchAgentService();

/** Risk level mapped to low-saturation Badge variants (Phase 5 extracts the shared dictionary). */
const RISK_VARIANTS = {
  LOW: "success",
  MEDIUM: "warning",
  HIGH: "danger",
} as const;

type Props = {
  workspaceSlug: string;
};

type TQueueState = "loading" | "ready" | "empty" | "error";

/** Normalize Agent risk values without exposing unknown backend codes. */
function riskLabelKey(value?: string) {
  const risk = String(value ?? "").toUpperCase();
  if (risk === "LOW" || risk === "MEDIUM" || risk === "HIGH") return `research.agent.risk.${risk.toLowerCase()}`;
  return "research.agent.risk.unknown";
}

/** Unified Agent approval queue backed by the real waiting-session endpoint. */
export function ResearchAgentApprovalQueue({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<TResearchAgentApproval[]>([]);
  const [state, setState] = useState<TQueueState>("loading");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const requestIdsRef = useRef<Record<string, string>>({});

  const load = useCallback(async () => {
    setState("loading");
    setError("");
    try {
      const payload = await agentService.getApprovals(workspaceSlug);
      setItems(payload.results);
      setState(payload.results.length ? "ready" : "empty");
    } catch {
      setItems([]);
      setState("error");
    }
  }, [workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (item: TResearchAgentApproval, decision: TAgentApprovalDecision) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const key = `${item.run_id}:${item.tool_call_id}:${decision}`;
      if (!requestIdsRef.current[key]) {
        requestIdsRef.current[key] =
          globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      }
      await agentService.decideApproval(workspaceSlug, item.run_id, {
        request_id: requestIdsRef.current[key],
        decision,
        tool_call_id: item.tool_call_id,
        reason: reason.trim() || undefined,
      });
      setFeedback(
        decision === "APPROVED"
          ? t("research.approvals.agent_feedback_approved")
          : t("research.approvals.agent_feedback_rejected")
      );
      setActiveId(null);
      setReason("");
      await load();
    } catch {
      setError(t("research.approvals.agent_action_failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="h-full overflow-y-auto p-5" aria-label={t("research.approvals.tabs.agent_approval")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-13 font-semibold text-primary">{t("research.approvals.tabs.agent_approval")}</h3>
          <p className="mt-0.5 text-11 text-tertiary">{t("research.approvals.agent_description")}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          {t("research.todo.refresh")}
        </Button>
      </div>

      {state === "loading" && (
        <div className="mt-4 space-y-2" role="status" aria-busy="true">
          {[0, 1, 2].map((row) => (
            <Skeleton.Item key={row} height="64px" width="100%" />
          ))}
        </div>
      )}
      {state === "error" && (
        <p className="mt-4 rounded-md border border-subtle bg-surface-1 p-4 text-12 text-secondary" role="alert">
          {t("research.approvals.load_failed")}
        </p>
      )}
      {state === "empty" && (
        <p className="mt-4 rounded-md border border-dashed border-subtle p-6 text-center text-12 text-secondary">
          {t("research.approvals.agent_empty")}
        </p>
      )}
      {feedback && <p className="mt-4 text-12 text-success-primary">{feedback}</p>}
      {error && (
        <p className="mt-4 text-12 text-danger-primary" role="alert">
          {error}
        </p>
      )}

      {state === "ready" && (
        <ul className="mt-4 divide-y divide-subtle rounded-xl border border-subtle bg-surface-1" role="list">
          {items.map((item) => (
            <li key={item.session_id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="brand">{t("research.approvals.source_agent")}</Badge>
                    <Badge variant={RISK_VARIANTS[item.risk_level as keyof typeof RISK_VARIANTS] ?? "neutral"}>
                      {t(riskLabelKey(item.risk_level))}
                    </Badge>
                    <p className="text-12 font-medium text-primary">{item.summary}</p>
                  </div>
                  <p className="mt-1 text-11 text-secondary">
                    {item.user_detail?.display_name || item.user_detail?.email || t("research.approvals.unknown_user")}
                    {` · ${new Date(item.updated_at).toLocaleString()}`}
                  </p>
                  <p className="mt-0.5 text-11 text-tertiary">
                    {item.project_name ?? item.project} · {item.chain_node_title ?? item.chain_node} ·{" "}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={`/${workspaceSlug}/research/chains/${item.chain}?tab=nodes&node=${item.chain_node}`}
                    className={getButtonStyling("secondary", "base")}
                  >
                    {t("research.approvals.open_chain_context")}
                  </Link>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setActiveId(item.session_id === activeId ? null : item.session_id)}
                    aria-expanded={item.session_id === activeId}
                  >
                    {t("research.approvals.process_agent")}
                  </Button>
                </div>
              </div>
              {item.session_id === activeId && (
                <div className="mt-3 rounded-lg border border-subtle bg-surface-2 p-3">
                  <label className="flex flex-col gap-1 text-11 text-secondary">
                    {t("research.approvals.comment_placeholder")}
                    <textarea
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      rows={3}
                      className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary"
                    />
                  </label>
                  <div className="mt-2 flex justify-end gap-2">
                    <Button variant="secondary" size="sm" onClick={() => void decide(item, "REJECTED")} disabled={busy}>
                      {t("research.approvals.reject")}
                    </Button>
                    <Button variant="primary" size="sm" onClick={() => void decide(item, "APPROVED")} disabled={busy}>
                      {t("research.approvals.approve")}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
