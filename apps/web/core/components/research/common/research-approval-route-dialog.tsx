"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "@plane/i18n";
import type { TResearchApprovalRoute, TResearchApprovalRouteCandidate } from "@plane/types";
import { Button } from "@plane/propel/button";
import { ModalCore } from "@plane/ui";

type Props = {
  open: boolean;
  title: string;
  load: () => Promise<TResearchApprovalRoute>;
  submitting: boolean;
  serverError?: string;
  onSubmit: (reviewerId: string, ccUserIds: string[]) => Promise<void> | void;
  onClose: () => void;
};

const ROLE_LABEL_KEYS: Record<string, string> = {
  PRIMARY_ADVISOR: "research.approval_route.roles.primary_advisor",
  ADVISOR: "research.approval_route.roles.advisor",
  MAIN_PI: "research.approval_route.roles.main_pi",
  UNIT_OWNER: "research.approval_route.roles.unit_owner",
  UNIT_PI: "research.approval_route.roles.unit_pi",
  UNIT_ADMIN: "research.approval_route.roles.unit_admin",
};

function roleLabel(role: string, t: (key: string) => string) {
  return t(ROLE_LABEL_KEYS[role] ?? "research.approval_route.roles.reviewer");
}

/**
 * Shared submission dialog for selecting one reviewer and optional carbon copies.
 */
export function ResearchApprovalRouteDialog({ open, title, load, submitting, serverError, onSubmit, onClose }: Props) {
  const { t } = useTranslation();
  const [route, setRoute] = useState<TResearchApprovalRoute | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reviewerId, setReviewerId] = useState("");
  const [ccUserIds, setCcUserIds] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);

  const loadRoute = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const loaded = await load();
      setRoute(loaded);
      setReviewerId(loaded.default_reviewer_id ?? "");
      setCcUserIds([]);
      setConfirmed(false);
    } catch {
      setLoadFailed(true);
      setRoute(null);
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    if (!open) return;
    void loadRoute();
  }, [loadRoute, open]);

  const selectedReviewer = useMemo(
    () => route?.candidates.find((candidate) => candidate.id === reviewerId) ?? null,
    [reviewerId, route]
  );
  const ccCandidates = useMemo(
    () => route?.candidates.filter((candidate) => candidate.id !== reviewerId) ?? [],
    [reviewerId, route]
  );
  const canSubmit = Boolean(reviewerId) && confirmed && !submitting && !loading;

  const toggleCc = (userId: string, checked: boolean) => {
    setCcUserIds((current) => (checked ? [...new Set([...current, userId])] : current.filter((id) => id !== userId)));
  };

  const candidateRows = (candidates: TResearchApprovalRouteCandidate[], kind: "reviewer" | "cc") => (
    <div className="mt-2 divide-y divide-subtle border-y border-subtle">
      {candidates.map((candidate) => {
        const checked = kind === "reviewer" ? candidate.id === reviewerId : ccUserIds.includes(candidate.id);
        return (
          <label key={candidate.id} className="flex cursor-pointer items-start gap-3 px-1 py-2.5 hover:bg-surface-2">
            <input
              type={kind === "reviewer" ? "radio" : "checkbox"}
              name="approval-reviewer"
              checked={checked}
              disabled={submitting || loading}
              onChange={(event) => {
                if (kind === "reviewer") {
                  setReviewerId(candidate.id);
                  setCcUserIds((current) => current.filter((id) => id !== candidate.id));
                  setConfirmed(false);
                } else {
                  toggleCc(candidate.id, event.target.checked);
                }
              }}
              className="accent-accent-primary mt-0.5 size-4"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-13 text-primary">{candidate.display_name}</span>
              <span className="mt-0.5 block truncate text-11 text-tertiary">
                {roleLabel(candidate.role, t)} · {candidate.email}
              </span>
            </span>
            {kind === "reviewer" && candidate.is_default && (
              <span className="shrink-0 text-11 text-tertiary">{t("research.approval_route.recommended")}</span>
            )}
          </label>
        );
      })}
    </div>
  );

  return (
    <ModalCore isOpen={open} handleClose={() => (!submitting ? onClose() : undefined)}>
      <section className="w-full max-w-xl bg-surface-1 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-16 font-semibold text-primary">{title}</h3>
            <p className="mt-1 text-12 text-secondary">{t("research.approval_route.subtitle")}</p>
          </div>
          <span className="shrink-0 text-11 text-tertiary">{t("research.approval_route.single_reviewer")}</span>
        </div>

        {loading && <p className="mt-4 text-13 text-secondary">{t("research.approval_route.loading")}</p>}
        {loadFailed && (
          <p role="alert" className="mt-4 text-13 text-danger-primary">
            {t("research.approval_route.load_failed")}
          </p>
        )}
        {!loading && !loadFailed && route && (
          <>
            <div className="mt-4">
              <h4 className="text-12 font-medium text-secondary">{t("research.approval_route.reviewer")}</h4>
              {route.candidates.length ? (
                candidateRows(route.candidates, "reviewer")
              ) : (
                <p className="mt-2 text-13 text-secondary">{t("research.approval_route.no_candidates")}</p>
              )}
            </div>

            {route.rules.cc_allowed && ccCandidates.length > 0 && (
              <div className="mt-5">
                <h4 className="text-12 font-medium text-secondary">{t("research.approval_route.cc")}</h4>
                {candidateRows(ccCandidates, "cc")}
              </div>
            )}

            {selectedReviewer && (
              <label className="mt-5 flex items-start gap-2 border-t border-subtle pt-4 text-12 text-secondary">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={submitting}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  className="accent-accent-primary mt-0.5 size-4"
                />
                <span>{t("research.approval_route.confirm", { name: selectedReviewer.display_name })}</span>
              </label>
            )}
          </>
        )}

        {(serverError || route?.candidates.length === 0) && (
          <p role="alert" className="mt-3 text-12 text-danger-primary">
            {serverError || t("research.approval_route.no_candidates")}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={submitting} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canSubmit}
            onClick={() => {
              if (reviewerId) void onSubmit(reviewerId, ccUserIds);
            }}
          >
            {submitting ? t("loading") : t("research.approval_route.submit")}
          </Button>
        </div>
      </section>
    </ModalCore>
  );
}
