"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type {
  TResearchChainEvent,
  TResearchPaperReview,
  TResearchPaperReviewAction,
  TResearchPaperReviewVersion,
} from "@plane/types";
import { formatResearchDateTime } from "@/components/research/common/research-format";
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import { ResearchPaperReviewService } from "@/services/research/paper-review.service";

type Props = {
  workspaceSlug: string;
  chainId: string;
  nodeId: string;
  events: TResearchChainEvent[];
};

type TPanelState = "loading" | "ready" | "forbidden" | "error";

type TDecisionAction = {
  action: Extract<TResearchPaperReviewAction, "return" | "accept" | "withdraw">;
  comment: string;
};

const REVIEW_STATUS_KEYS: Record<TResearchPaperReview["status"], string> = {
  OPEN: "research.paper_reviews.status.open",
  WAITING_REVIEW: "research.paper_reviews.status.waiting_review",
  NEEDS_REVISION: "research.paper_reviews.status.needs_revision",
  ACCEPTED: "research.paper_reviews.status.accepted",
  WITHDRAWN: "research.paper_reviews.status.withdrawn",
};

const VERSION_STATUS_KEYS: Record<TResearchPaperReviewVersion["status"], string> = {
  SUBMITTED: "research.paper_reviews.version_status.submitted",
  SUPERSEDED: "research.paper_reviews.version_status.superseded",
  ACCEPTED: "research.paper_reviews.version_status.accepted",
};

const EVENT_TYPE_KEYS: Record<string, string> = {
  PAPER_REVIEW_OPENED: "research.paper_reviews.events.opened",
  PAPER_VERSION_SUBMITTED: "research.paper_reviews.events.version_submitted",
  PAPER_REVIEW_RETURNED: "research.paper_reviews.events.returned",
  PAPER_REVIEW_ACCEPTED: "research.paper_reviews.events.accepted",
  PAPER_REVIEW_WITHDRAWN: "research.paper_reviews.events.withdrawn",
};

/**
 * Resolve a compact display name from a paper user projection.
 *
 * Args:
 *   user: Owner or final reviewer projection returned by the review API.
 *
 * Returns:
 *   The display name, or an em dash when the backend has no projection.
 */
function userName(user: { display_name?: string } | null | undefined) {
  return user?.display_name || "—";
}

/**
 * Read a human-readable rejection message from a research API error body.
 *
 * Args:
 *   error: Object thrown by the paper review service.
 *   fallback: Translation shown when the server provides no useful text.
 *
 * Returns:
 *   The safest available server-side rejection description.
 */
function serverErrorMessage(error: unknown, fallback: string) {
  const payload = error as { error?: unknown; detail?: unknown; error_code?: string } | undefined;
  if (typeof payload?.error === "string" && payload.error.trim()) return payload.error;
  if (typeof payload?.detail === "string" && payload.detail.trim()) return payload.detail;
  return payload?.error_code ? `${fallback} (${payload.error_code})` : fallback;
}

/**
 * Determine whether the server explicitly allows a paper action.
 *
 * Args:
 *   review: Review carrying the capability map.
 *   action: Requested display-layer action.
 *
 * Returns:
 *   True only when the backend marked the action allowed.
 */
function isAllowed(review: TResearchPaperReview | null, action: TResearchPaperReviewAction) {
  return review?.capabilities?.actions[action]?.allowed === true;
}

/**
 * Match one Chain Event to a paper review through its immutable refs.
 *
 * Args:
 *   event: Chain Event returned by the node timeline.
 *   reviewId: Selected paper review id.
 *
 * Returns:
 *   True when the event references the selected review.
 */
function eventMatchesReview(event: TResearchChainEvent, reviewId: string) {
  return event.refs.some((reference) => reference.kind === "paper_review" && reference.id === reviewId);
}

/**
 * Read a decision comment stored in Chain Event metadata.
 *
 * Args:
 *   event: Chain Event potentially carrying a comment.
 *
 * Returns:
 *   The comment text, or an empty string when the event has no comment.
 */
function eventComment(event: TResearchChainEvent) {
  const comment = event.metadata?.comment;
  return typeof comment === "string" ? comment.trim() : "";
}

/**
 * Format a byte count without adding another locale dependency.
 *
 * Args:
 *   size: File size returned by the version API.
 *
 * Returns:
 *   A compact B / KB / MB representation.
 */
function fileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Compute the SHA-256 digest required by the paper presign contract.
 *
 * Args:
 *   file: File selected for the next immutable version.
 *
 * Returns:
 *   A lowercase hex digest, or an empty string when Web Crypto is unavailable.
 */
async function fileSha256(file: File) {
  if (!globalThis.crypto?.subtle) return "";
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Load and operate the paper review loop attached to a writing node. */
export function ResearchPaperReviewPanel({ workspaceSlug, chainId, nodeId, events }: Props) {
  const { t, currentLocale } = useTranslation();
  const service = useMemo(() => new ResearchPaperReviewService(), []);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [reviews, setReviews] = useState<TResearchPaperReview[]>([]);
  const [review, setReview] = useState<TResearchPaperReview | null>(null);
  const [chainEvents, setChainEvents] = useState<TResearchChainEvent[]>(events);
  const [state, setState] = useState<TPanelState>("loading");
  const [file, setFile] = useState<File | null>(null);
  const [changeSummary, setChangeSummary] = useState("");
  const [decisionAction, setDecisionAction] = useState<TDecisionAction | null>(null);
  const [busy, setBusy] = useState("");
  const [formError, setFormError] = useState("");
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    setChainEvents(events);
  }, [events]);

  const load = useCallback(
    async (preferredReviewId?: string) => {
      setState("loading");
      setActionError("");
      try {
        const list = await service.getPaperReviews(workspaceSlug, chainId, nodeId);
        const selectedId =
          list.find((item) => item.id === (preferredReviewId ?? review?.id))?.id ?? list[0]?.id ?? null;
        setReviews(list);
        if (!selectedId) {
          setReview(null);
          setState("ready");
          return;
        }
        const detail = await service.getPaperReview(workspaceSlug, selectedId);
        setReview(detail);
        setState("ready");
      } catch (error) {
        const errorCode = (error as { error_code?: string })?.error_code;
        setState(errorCode === "research_permission_denied" ? "forbidden" : "error");
      }
    },
    [chainId, nodeId, review?.id, service, workspaceSlug]
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const list = await service.getPaperReviews(workspaceSlug, chainId, nodeId);
        const selectedId = list[0]?.id ?? null;
        const detail = selectedId ? await service.getPaperReview(workspaceSlug, selectedId) : null;
        if (!active) return;
        setReviews(list);
        setReview(detail);
        setState("ready");
      } catch (error) {
        if (!active) return;
        const errorCode = (error as { error_code?: string })?.error_code;
        setState(errorCode === "research_permission_denied" ? "forbidden" : "error");
      }
    })();
    return () => {
      active = false;
    };
  }, [chainId, nodeId, service, workspaceSlug]);

  /**
   * Merge a refreshed review while keeping list and detail state consistent.
   *
   * Args:
   *   nextReview: Latest detail projection returned by the server.
   */
  const upsertReview = useCallback((nextReview: TResearchPaperReview) => {
    setReview(nextReview);
    setReviews((current) => {
      const index = current.findIndex((item) => item.id === nextReview.id);
      if (index === -1) return [nextReview, ...current];
      return [...current.slice(0, index), nextReview, ...current.slice(index + 1)];
    });
  }, []);

  /** Refresh Chain Events after a mutation without blocking the review update. */
  const refreshEvents = useCallback(async () => {
    try {
      setChainEvents(await service.getPaperChainEvents(workspaceSlug, nodeId));
    } catch {
      // Event refresh is diagnostic; the action response remains authoritative.
    }
  }, [nodeId, service, workspaceSlug]);

  /**
   * Refresh the selected review after a server-side state transition.
   *
   * Args:
   *   reviewId: Review whose detail should be re-read.
   */
  const refreshReview = useCallback(
    async (reviewId: string) => {
      const detail = await service.getPaperReview(workspaceSlug, reviewId);
      upsertReview(detail);
    },
    [service, upsertReview, workspaceSlug]
  );

  /** Clear the upload form after a successful immutable version submission. */
  const resetUploadForm = () => {
    setFile(null);
    setChangeSummary("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  /** Validate, upload, bind and then refresh the next paper version. */
  const submitVersion = async () => {
    if (!review || !file || !changeSummary.trim()) {
      setFormError(t("research.paper_reviews.upload_required"));
      return;
    }
    setBusy("submit");
    setFormError("");
    try {
      const digest = await fileSha256(file);
      if (!digest) throw new Error(t("research.paper_reviews.crypto_unavailable"));
      const assetId = await service.uploadPaperVersion(workspaceSlug, review.id, file, digest);
      await service.submitPaperVersion(workspaceSlug, review.id, {
        asset_id: assetId,
        change_summary: changeSummary.trim(),
      });
      await refreshReview(review.id);
      await refreshEvents();
      resetUploadForm();
    } catch (error) {
      setFormError(serverErrorMessage(error, t("research.paper_reviews.upload_failed")));
    } finally {
      setBusy("");
    }
  };

  /** Run return, final confirmation, or withdrawal after local validation. */
  const runDecision = async () => {
    if (!review || !decisionAction) return;
    const needsReason = decisionAction.action !== "accept";
    if (needsReason && !decisionAction.comment.trim()) {
      setActionError(t("research.paper_reviews.reason_required"));
      return;
    }
    setBusy(decisionAction.action);
    setActionError("");
    try {
      if (decisionAction.action === "withdraw") {
        const withdrawn = await service.withdrawPaperReview(workspaceSlug, review.id, decisionAction.comment.trim());
        upsertReview(withdrawn);
      } else if (decisionAction.action === "return") {
        await service.returnPaperVersion(workspaceSlug, review.id, review.current_version_no, {
          comment: decisionAction.comment.trim(),
        });
        await refreshReview(review.id);
      } else {
        await service.acceptPaperVersion(workspaceSlug, review.id, review.current_version_no, {
          comment: decisionAction.comment.trim(),
        });
        await refreshReview(review.id);
      }
      await refreshEvents();
      setDecisionAction(null);
    } catch (error) {
      setActionError(serverErrorMessage(error, t("research.paper_reviews.server_rejected")));
    } finally {
      setBusy("");
    }
  };

  /**
   * Open a paper asset through the server's presigned download endpoint.
   *
   * Args:
   *   version: Version whose immutable file should be opened.
   */
  const openAsset = async (version: TResearchPaperReviewVersion) => {
    const busyKey = `file:${version.id}`;
    setBusy(busyKey);
    setActionError("");
    try {
      const url = await service.getPaperAssetUrl(workspaceSlug, version.asset);
      if (!url) throw { error_code: "asset_not_found" };
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setActionError(serverErrorMessage(error, t("research.paper_reviews.file_failed")));
    } finally {
      setBusy("");
    }
  };

  const versions = useMemo(
    // The array is copied from the response, so sorting it cannot mutate source data.
    // eslint-disable-next-line unicorn/no-array-sort -- TypeScript target does not include Array#toSorted.
    () => [...(review?.versions ?? [])].sort((left, right) => right.version_no - left.version_no),
    [review?.versions]
  );
  const reviewId = review?.id ?? null;
  const reviewEvents = useMemo(
    () =>
      chainEvents
        .filter((event) => (reviewId ? eventMatchesReview(event, reviewId) : false))
        // The array is created by filter, so sorting it cannot mutate source data.
        // eslint-disable-next-line unicorn/no-array-sort -- TypeScript target does not include Array#toSorted.
        .sort((left, right) => left.occurred_at.localeCompare(right.occurred_at)),
    [chainEvents, reviewId]
  );
  const returnEvents = reviewEvents.filter((event) => event.event_type === "PAPER_REVIEW_RETURNED");
  const latestReturn = returnEvents[returnEvents.length - 1];
  const latestReturnComment = latestReturn ? eventComment(latestReturn) : "";
  const latestVersion = versions[0];
  const finalConfirmed = review?.status === "ACCEPTED" && latestVersion?.status === "ACCEPTED";

  return (
    <section className="p-5" aria-label={t("research.paper_reviews.panel_title")}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-15 font-semibold text-primary">{t("research.paper_reviews.panel_title")}</h3>
          <p className="mt-1 text-12 text-secondary">{t("research.paper_reviews.panel_hint")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" disabled={state === "loading"} onClick={() => void load()}>
            {t("research.paper_reviews.refresh")}
          </Button>
          {review && isAllowed(review, "withdraw") && !decisionAction && (
            <Button
              variant="secondary"
              size="sm"
              disabled={Boolean(busy)}
              onClick={() => setDecisionAction({ action: "withdraw", comment: "" })}
            >
              {t("research.paper_reviews.withdraw")}
            </Button>
          )}
        </div>
      </header>

      <div className="mt-4 border-t border-subtle pt-4">
        {state === "loading" && (
          <p className="text-12 text-tertiary" role="status">
            {t("research.paper_reviews.loading")}
          </p>
        )}
        {state === "forbidden" && (
          <p className="text-12 text-primary" role="alert">
            {t("research.paper_reviews.no_permission")}
          </p>
        )}
        {state === "error" && (
          <p className="text-12 text-danger-primary" role="alert">
            {t("research.paper_reviews.load_failed")}
          </p>
        )}

        {state === "ready" && !review && <p className="text-12 text-tertiary">{t("research.paper_reviews.empty")}</p>}

        {state === "ready" && review && (
          <>
            {reviews.length > 1 && (
              <nav className="mb-4 flex flex-wrap gap-2" aria-label={t("research.paper_reviews.review_switch")}>
                {reviews.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => void load(item.id)}
                    aria-pressed={item.id === review.id || undefined}
                    className={`rounded-md border px-3 py-1.5 text-12 transition-colors hover:bg-surface-2 ${
                      item.id === review.id ? "border-strong text-primary" : "border-subtle text-secondary"
                    }`}
                  >
                    {t(REVIEW_STATUS_KEYS[item.status])} · {item.id.slice(0, 8)}
                  </button>
                ))}
              </nav>
            )}

            <dl className="grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-4">
              <div>
                <dt className="text-11 text-tertiary">{t("research.paper_reviews.status")}</dt>
                <dd className="mt-1">
                  <ResearchStatusBadge status={review.status}>
                    {t(REVIEW_STATUS_KEYS[review.status])}
                  </ResearchStatusBadge>
                </dd>
              </div>
              <div>
                <dt className="text-11 text-tertiary">{t("research.paper_reviews.final_reviewer")}</dt>
                <dd className="mt-1 text-12 text-primary">{userName(review.final_reviewer_detail ?? undefined)}</dd>
              </div>
              <div>
                <dt className="text-11 text-tertiary">{t("research.paper_reviews.due_at")}</dt>
                <dd className="mt-1 text-12 text-primary">
                  {review.due_at ? formatResearchDateTime(review.due_at, currentLocale) : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-11 text-tertiary">{t("research.paper_reviews.final_confirmation")}</dt>
                <dd className="mt-1">
                  <ResearchStatusBadge status={finalConfirmed ? "accepted" : "pending"}>
                    {finalConfirmed
                      ? t("research.paper_reviews.final_confirmed")
                      : t("research.paper_reviews.final_unconfirmed")}
                  </ResearchStatusBadge>
                </dd>
              </div>
            </dl>

            <div className="mt-5 grid grid-cols-1 gap-x-8 gap-y-6 xl:grid-cols-2">
              <section aria-label={t("research.paper_reviews.versions_title")}>
                <h4 className="text-12 font-semibold text-primary">{t("research.paper_reviews.versions_title")}</h4>
                <ol className="mt-3 divide-y divide-subtle border-t border-subtle" role="list">
                  {versions.map((version) => (
                    <li key={version.id} className="py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-12 font-medium text-primary">
                            {t("research.paper_reviews.version", { version: version.version_no })} · {version.file_name}
                          </p>
                          <p className="mt-1 text-11 text-tertiary">
                            {formatResearchDateTime(version.submitted_at, currentLocale)} ·{" "}
                            {userName(version.submitted_by_detail ?? undefined)} · {fileSize(version.file_size)}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <ResearchStatusBadge status={version.status.toLowerCase()} size="sm">
                            {t(VERSION_STATUS_KEYS[version.status])}
                          </ResearchStatusBadge>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy === `file:${version.id}`}
                            onClick={() => void openAsset(version)}
                          >
                            {busy === `file:${version.id}`
                              ? t("research.paper_reviews.processing")
                              : t("research.paper_reviews.open_file")}
                          </Button>
                        </div>
                      </div>
                      <p className="mt-2 text-12 text-secondary">{version.change_summary}</p>
                    </li>
                  ))}
                  {!versions.length && (
                    <li className="py-3 text-12 text-tertiary">{t("research.paper_reviews.version_empty")}</li>
                  )}
                </ol>

                {isAllowed(review, "submit") && (
                  <form
                    className="mt-4 grid grid-cols-1 gap-3 border-t border-subtle pt-4"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void submitVersion();
                    }}
                  >
                    <label className="flex min-w-0 flex-col gap-1 text-11 text-tertiary">
                      <span>{t("research.paper_reviews.file")}</span>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".pdf,.md,.markdown,application/pdf,text/markdown"
                        className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary"
                        onChange={(event) => {
                          setFile(event.target.files?.[0] ?? null);
                          setFormError("");
                        }}
                      />
                    </label>
                    <label className="flex min-w-0 flex-col gap-1 text-11 text-tertiary">
                      <span>{t("research.paper_reviews.change_summary")}</span>
                      <textarea
                        value={changeSummary}
                        rows={3}
                        onChange={(event) => setChangeSummary(event.target.value)}
                        className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary"
                      />
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy === "submit"}
                        onClick={() => void submitVersion()}
                      >
                        {busy === "submit"
                          ? t("research.paper_reviews.processing")
                          : t("research.paper_reviews.submit")}
                      </Button>
                      <Button variant="secondary" size="sm" disabled={busy === "submit"} onClick={resetUploadForm}>
                        {t("research.paper_reviews.cancel_edit")}
                      </Button>
                    </div>
                    {formError && (
                      <p className="text-12 text-danger-primary" role="alert">
                        {formError}
                      </p>
                    )}
                  </form>
                )}
              </section>

              <section aria-label={t("research.paper_reviews.comments_title")}>
                <h4 className="text-12 font-semibold text-primary">{t("research.paper_reviews.comments_title")}</h4>
                <div className="mt-3 bg-surface-2 px-3 py-3">
                  <p className="text-11 text-tertiary">{t("research.paper_reviews.return_opinion")}</p>
                  <p className="mt-1 text-12 text-primary">
                    {latestReturnComment || t("research.paper_reviews.return_empty")}
                  </p>
                  {latestReturn && (
                    <p className="mt-1 text-11 text-tertiary">
                      {formatResearchDateTime(latestReturn.occurred_at, currentLocale)}
                    </p>
                  )}
                </div>
                <ol className="mt-4 space-y-0 border-l border-subtle pl-4" role="list">
                  {reviewEvents.map((event) => (
                    <li key={event.event_id} className="relative py-2 pl-4 first:pt-0 last:pb-0">
                      <span
                        className="bg-border-strong absolute top-[15px] -left-[21px] size-2 rounded-full"
                        aria-hidden="true"
                      />
                      <p className="text-12 font-medium text-primary">
                        {t(EVENT_TYPE_KEYS[event.event_type] ?? "research.paper_reviews.events.other")}
                      </p>
                      <p className="mt-1 text-12 text-secondary">{eventComment(event) || event.summary}</p>
                      <p className="mt-1 text-11 text-tertiary">
                        {formatResearchDateTime(event.occurred_at, currentLocale)} · {event.actor_type}
                      </p>
                    </li>
                  ))}
                  {!reviewEvents.length && (
                    <li className="py-2 text-12 text-tertiary">{t("research.paper_reviews.comments_empty")}</li>
                  )}
                </ol>

                {(isAllowed(review, "return") || isAllowed(review, "accept")) && !decisionAction && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {isAllowed(review, "return") && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={Boolean(busy)}
                        onClick={() => setDecisionAction({ action: "return", comment: "" })}
                      >
                        {t("research.paper_reviews.return")}
                      </Button>
                    )}
                    {isAllowed(review, "accept") && (
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={Boolean(busy)}
                        onClick={() => setDecisionAction({ action: "accept", comment: "" })}
                      >
                        {t("research.paper_reviews.final_confirm")}
                      </Button>
                    )}
                  </div>
                )}
              </section>
            </div>

            {decisionAction && (
              <div className="mt-5 grid grid-cols-1 gap-3 border-t border-subtle pt-4 md:grid-cols-[minmax(0,1fr)_auto_auto]">
                <label className="flex min-w-0 flex-col gap-1 text-11 text-tertiary">
                  <span>
                    {decisionAction.action === "return"
                      ? t("research.paper_reviews.return_reason")
                      : decisionAction.action === "accept"
                        ? t("research.paper_reviews.confirm_note")
                        : t("research.paper_reviews.withdraw_reason")}
                  </span>
                  <textarea
                    value={decisionAction.comment}
                    rows={2}
                    onChange={(event) =>
                      setDecisionAction((current) => (current ? { ...current, comment: event.target.value } : current))
                    }
                    className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary"
                  />
                </label>
                <Button
                  variant={decisionAction.action === "accept" ? "primary" : "secondary"}
                  size="sm"
                  className="mt-auto"
                  disabled={busy === decisionAction.action}
                  onClick={() => void runDecision()}
                >
                  {busy === decisionAction.action
                    ? t("research.paper_reviews.processing")
                    : t("research.paper_reviews.confirm")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-auto"
                  disabled={Boolean(busy)}
                  onClick={() => setDecisionAction(null)}
                >
                  {t("research.paper_reviews.cancel_edit")}
                </Button>
              </div>
            )}
          </>
        )}

        {actionError && state !== "forbidden" && (
          <p className="mt-4 text-12 text-danger-primary" role="alert">
            {actionError}
          </p>
        )}
      </div>
    </section>
  );
}
