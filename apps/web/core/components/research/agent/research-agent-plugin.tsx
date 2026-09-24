"use client";

import { useEffect, useRef } from "react";
// plane imports
import { useTranslation } from "@plane/i18n";
// components
import { ResearchAgentHeader } from "@/components/research/agent/research-agent-header";
import { ResearchAgentPageLayout } from "@/components/research/agent/research-agent-page-layout";
import { ResearchAgentPanelLayout } from "@/components/research/agent/research-agent-panel-layout";
import { useResearchAgentSession } from "@/components/research/agent/use-research-agent-session";
import { agentPayloadText } from "@/components/research/agent/research-agent-utils";

type Props = {
  workspaceSlug: string;
  chainNodeId: string;
  /** "panel" renders a condensed side-panel layout; "page" keeps the full workbench. */
  variant?: "page" | "panel";
};

/** Same-origin Research Agent workbench with structured cards, drawers and trace filters. */
export const ResearchAgentPlugin = function ResearchAgentPlugin({
  workspaceSlug,
  chainNodeId,
  variant = "page",
}: Props) {
  const { t } = useTranslation();
  const api = useResearchAgentSession(workspaceSlug, chainNodeId);
  const approvalDrawerRef = useRef<HTMLDivElement | null>(null);
  const artifactDrawerRef = useRef<HTMLDivElement | null>(null);
  const { approvalFor, artifactDrawerOpen, setApprovalFor, setArtifactDrawerOpen } = api;

  useEffect(() => {
    const drawer = approvalFor ? approvalDrawerRef.current : artifactDrawerOpen ? artifactDrawerRef.current : null;
    drawer?.focus();
  }, [approvalFor, artifactDrawerOpen]);

  useEffect(() => {
    if (!approvalFor && !artifactDrawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setApprovalFor(null);
        setArtifactDrawerOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [approvalFor, artifactDrawerOpen, setApprovalFor, setArtifactDrawerOpen]);

  return (
    <section className="flex h-full flex-col overflow-hidden" aria-label={t("research.agent.description")}>
      <ResearchAgentHeader api={api} variant={variant} />
      {variant === "panel" ? <ResearchAgentPanelLayout api={api} /> : <ResearchAgentPageLayout api={api} />}

      {api.activeApproval && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-label={t("research.agent.close_drawer")}
            onClick={() => api.setApprovalFor(null)}
            className="fixed inset-0 z-40 bg-black/20"
          />
          <div
            ref={approvalDrawerRef}
            role="dialog"
            aria-modal="true"
            aria-label={t("research.agent.approval_drawer")}
            tabIndex={-1}
            className="fixed top-0 right-0 z-50 flex h-full w-full max-w-md flex-col border-l border-subtle bg-surface-1 outline-none"
          >
            <div className="flex items-center justify-between border-b border-subtle px-4 py-3">
              <h3 className="text-13 font-semibold text-primary">{t("research.agent.approval_drawer")}</h3>
              <button
                type="button"
                onClick={() => api.setApprovalFor(null)}
                className="rounded-md px-2 py-1 text-12 text-secondary hover:bg-surface-2"
              >
                {t("research.agent.close_drawer")}
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <p className="text-12 font-medium text-primary">
                {agentPayloadText(api.activeApproval.payload, ["tool_name", "tool", "name", "capability"]) ||
                  api.activeApproval.event_type}
              </p>
              <p className="mt-1 text-12 text-secondary">
                {agentPayloadText(api.activeApproval.payload, ["input_summary", "query", "input", "prompt"]) ||
                  t("research.agent.approval_scope_hint")}
              </p>
              <label className="mt-4 flex flex-col gap-1 text-11 text-secondary">
                {t("research.agent.approval_reason")}
                <textarea
                  value={api.approvalReason}
                  onChange={(event) => api.setApprovalReason(event.target.value)}
                  rows={4}
                  className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary"
                />
              </label>
              {api.approvalResult && <p className="mt-3 text-12 text-success-primary">{api.approvalResult}</p>}
              {api.approvalError && (
                <p className="mt-3 text-12 text-danger-primary" role="alert">
                  {api.approvalError}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-subtle px-4 py-3">
              <button
                type="button"
                onClick={() => void api.decideApproval("REJECTED")}
                disabled={api.approvalBusy}
                className="rounded-md border border-danger-strong/40 px-3 py-1.5 text-12 text-danger-primary disabled:opacity-50"
              >
                {t("research.approvals.reject")}
              </button>
              <button
                type="button"
                onClick={() => void api.decideApproval("APPROVED")}
                disabled={api.approvalBusy}
                className="rounded-md bg-accent-primary px-3 py-1.5 text-12 text-on-color disabled:opacity-50"
              >
                {api.approvalBusy ? t("research.agent.status.SAVING") : t("research.approvals.approve")}
              </button>
            </div>
          </div>
        </>
      )}

      {api.artifactDrawerOpen && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-label={t("research.agent.close_drawer")}
            onClick={() => api.setArtifactDrawerOpen(false)}
            className="fixed inset-0 z-40 bg-black/20"
          />
          <div
            ref={artifactDrawerRef}
            role="dialog"
            aria-modal="true"
            aria-label={t("research.agent.artifact_drawer")}
            tabIndex={-1}
            className="fixed top-0 right-0 z-50 flex h-full w-full max-w-md flex-col border-l border-subtle bg-surface-1 outline-none"
          >
            <div className="flex items-center justify-between border-b border-subtle px-4 py-3">
              <h3 className="text-13 font-semibold text-primary">{t("research.agent.artifact_drawer")}</h3>
              <button
                type="button"
                onClick={() => api.setArtifactDrawerOpen(false)}
                className="rounded-md px-2 py-1 text-12 text-secondary hover:bg-surface-2"
              >
                {t("research.agent.close_drawer")}
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <label className="flex flex-col gap-1 text-11 text-secondary">
                {t("research.agent.artifact_preview")}
                <textarea
                  value={api.artifactDraft}
                  onChange={(event) => api.setArtifactDraft(event.target.value)}
                  placeholder={t("research.agent.artifact_placeholder")}
                  rows={10}
                  className="w-full resize-none rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary"
                />
              </label>
              <label className="mt-3 flex flex-col gap-1 text-11 text-secondary">
                {t("research.agent.artifact_type")}
                <select
                  value={api.artifactType}
                  onChange={(event) => api.setArtifactType(event.target.value)}
                  className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-11 text-primary"
                >
                  {[
                    "RESEARCH_PLAN_DRAFT",
                    "LITERATURE_REFERENCE",
                    "EXPERIMENT_RECORD",
                    "EXPERIMENT_DATA",
                    "ANALYSIS_SUMMARY",
                    "PROCESS_NOTE",
                  ].map((type) => (
                    <option key={type} value={type}>
                      {t(`research.agent.artifact_type_${type.toLowerCase()}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="mt-3 flex items-center gap-2 text-11 text-secondary">
                <input
                  type="checkbox"
                  checked={api.artifactConfirmed}
                  onChange={(event) => api.setArtifactConfirmed(event.target.checked)}
                />
                {t("research.agent.artifact_confirm")}
              </label>
              {api.savedArtifact && <p className="mt-3 text-12 text-success-primary">{api.savedArtifact}</p>}
              {api.artifactError && (
                <p className="mt-3 text-12 text-danger-primary" role="alert">
                  {api.artifactError}
                </p>
              )}
            </div>
            <div className="flex justify-end border-t border-subtle px-4 py-3">
              <button
                type="button"
                onClick={() => void api.saveArtifact()}
                disabled={!api.session || !api.artifactDraft.trim() || !api.artifactConfirmed || api.savingArtifact}
                className="rounded-md bg-accent-primary px-3 py-1.5 text-12 text-on-color disabled:opacity-50"
              >
                {api.savingArtifact ? t("research.agent.status.SAVING") : t("research.agent.save_artifact")}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
};
