/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { observer } from "mobx-react";
// plane imports
import {
  REPORT_STATUS_LABELS,
  REPORT_TYPE_LABELS,
  REPORT_VISIBILITIES,
  REPORT_VISIBILITY_ORDER,
  REPORT_VISIBILITY_LABELS,
} from "@plane/constants";
import type { TReportVisibility } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type { TEditorCommentAnchor, TEditorSelectionAnchor } from "@plane/editor";
import { Button } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { Input, ModalCore } from "@plane/ui";
// components
import { ReportBody, type ReportBodyRef } from "@/components/research/reports/report-body";
import { ResearchDeleteButton } from "@/components/research/common/research-delete-button";
import { getResearchErrorKey } from "@/components/research/common/error-messages";
import { ResearchDetailHeader, ResearchDetailSurface } from "@/components/research/common/research-data-surface";
import { ResearchApprovalRouteDialog } from "@/components/research/common/research-approval-route-dialog";
import { ShareLinkIconButton } from "@/components/common/share-link-icon-button";
import { ResearchReportAttachments } from "@/components/research/reports/report-attachments";
import { ResearchReportComments, useResearchReportCommentsPanel } from "@/components/research/reports/report-comments";
import { ResearchReportService } from "@/services/research/report.service";
// hooks
import { useResearch } from "@/hooks/store/use-research";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { formatResearchDateTime, formatResearchReadAt } from "@/components/research/common/research-format";

type Props = {
  workspaceSlug: string;
  reportId: string;
};

type ReportReadState = "waiting" | "read_pending_review" | "reviewed";

/** Keep the advisor read signal separate from workflow status.
 * The signal (author's mentors + main PI) is the same for every viewer. */
function reportReadState(report: { status: string; read_count?: number }): ReportReadState | null {
  if (report.status === "DRAFT") return null;
  if (report.status !== "SUBMITTED") return "reviewed";
  return (report.read_count ?? 0) > 0 ? "read_pending_review" : "waiting";
}

/**
 * Report detail: metadata, workflow actions, review history and visibility
 * management. The body itself is edited through the linked Plane Page so the
 * shared editor and its versioning are reused (P0-UI-03).
 */
export const ResearchReportDetail = observer(function ResearchReportDetail({ workspaceSlug, reportId }: Props) {
  const { t, currentLocale } = useTranslation();
  const navigate = useNavigate();
  const research = useResearch();
  const reportService = useMemo(() => new ResearchReportService(), []);
  const { getWorkspaceBySlug } = useWorkspace();
  const [returnReason, setReturnReason] = useState("");
  const [showReturn, setShowReturn] = useState(false);
  const [showSubmitRoute, setShowSubmitRoute] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState("");
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const bodyRef = useRef<ReportBodyRef>(null);
  const [bodyBusy, setBodyBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<
    "save" | "submit" | "withdraw" | "return" | "accept" | "visibility" | null
  >(null);
  const [draftAnchor, setDraftAnchor] = useState<TEditorSelectionAnchor | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [commentAnchors, setCommentAnchors] = useState<TEditorCommentAnchor[]>([]);
  const readReceiptKeyRef = useRef<string | null>(null);
  const commentsPanel = useResearchReportCommentsPanel();

  const report = research.reports[reportId];
  const history = research.reportHistory[reportId] ?? [];
  const workspaceId = getWorkspaceBySlug(workspaceSlug)?.id ?? "";
  const currentUserId = research.identity?.user.id;
  const readState = report ? reportReadState(report) : null;
  const authorName = report?.owner_detail?.display_name || report?.owner_detail?.email || report?.owner;
  const effectiveVisibility = report?.effective_visibility ?? report?.visibility;
  const weeklyConfidential = report?.weekly_confidential ?? false;
  const visibilityOptions = REPORT_VISIBILITIES.filter(
    (visibility) =>
      visibility !== "CUSTOM" &&
      (!weeklyConfidential || REPORT_VISIBILITY_ORDER[visibility] <= REPORT_VISIBILITY_ORDER.UNIT)
  );

  useEffect(() => {
    void (async () => {
      try {
        await research.fetchReport(workspaceSlug, reportId);
        await research.fetchReportHistory(workspaceSlug, reportId);
      } catch (error) {
        setErrorKey(getResearchErrorKey(error));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug, reportId]);

  useEffect(() => {
    if (
      !report ||
      report.owner === currentUserId ||
      !report.official_content ||
      report.has_read ||
      !report.official_content.version_no
    ) {
      return;
    }
    const receiptKey = `${report.id}:${report.official_content.version_no}`;
    if (readReceiptKeyRef.current === receiptKey) return;
    readReceiptKeyRef.current = receiptKey;
    research.markReportRead(workspaceSlug, report.id).catch(() => undefined);
  }, [currentUserId, report, research, workspaceSlug]);

  const loadApprovalRoute = useCallback(
    () => reportService.getApprovalRoute(workspaceSlug, reportId),
    [reportId, reportService, workspaceSlug]
  );

  const submitWithRoute = useCallback(
    async (reviewerId: string, ccUserIds: string[]) => {
      if (pendingAction) return;
      setPendingAction("submit");
      try {
        if (!(await bodyRef.current?.save())) return;
        await research.submitReport(workspaceSlug, reportId, {
          reviewer_id: reviewerId,
          cc_user_ids: ccUserIds,
        });
        await Promise.all([research.fetchReport(workspaceSlug, reportId), research.fetchReports(workspaceSlug)]);
        setShowSubmitRoute(false);
        setErrorKey(null);
        setToast({
          type: TOAST_TYPE.SUCCESS,
          title: t("research.feedback.report_submitted.title"),
          message: t("research.feedback.report_submitted.message"),
        });
      } catch (error) {
        setErrorKey(getResearchErrorKey(error));
      } finally {
        setPendingAction(null);
      }
    },
    [pendingAction, reportId, research, t, workspaceSlug]
  );

  const handleSubmit = useCallback(() => {
    if (pendingAction) return;
    setShowSubmitRoute(true);
  }, [pendingAction]);

  const handleWithdraw = useCallback(async () => {
    if (pendingAction) return;
    setPendingAction("withdraw");
    try {
      await research.withdrawReport(workspaceSlug, reportId, withdrawReason.trim());
      await Promise.all([research.fetchReport(workspaceSlug, reportId), research.fetchReports(workspaceSlug)]);
      setWithdrawReason("");
      setShowWithdraw(false);
      setErrorKey(null);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("research.feedback.report_withdrawn.title"),
        message: t("research.feedback.report_withdrawn.message"),
      });
    } catch (error) {
      setErrorKey(getResearchErrorKey(error));
    } finally {
      setPendingAction(null);
    }
  }, [pendingAction, reportId, research, t, withdrawReason, workspaceSlug]);

  const handleReturn = useCallback(async () => {
    if (pendingAction || !returnReason.trim()) return;
    setPendingAction("return");
    try {
      await research.returnReport(workspaceSlug, reportId, returnReason.trim());
      await Promise.all([research.fetchReport(workspaceSlug, reportId), research.fetchReports(workspaceSlug)]);
      setReturnReason("");
      setShowReturn(false);
      setErrorKey(null);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("research.feedback.report_returned.title"),
        message: t("research.feedback.report_returned.message"),
      });
    } catch (error) {
      setErrorKey(getResearchErrorKey(error));
    } finally {
      setPendingAction(null);
    }
  }, [pendingAction, reportId, research, returnReason, t, workspaceSlug]);

  const handleAccept = useCallback(async () => {
    if (pendingAction) return;
    setPendingAction("accept");
    try {
      await research.acceptReport(workspaceSlug, reportId);
      await Promise.all([research.fetchReport(workspaceSlug, reportId), research.fetchReports(workspaceSlug)]);
      setErrorKey(null);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("research.feedback.report_accepted.title"),
        message: t("research.feedback.report_accepted.message"),
      });
    } catch (error) {
      setErrorKey(getResearchErrorKey(error));
    } finally {
      setPendingAction(null);
    }
  }, [pendingAction, reportId, research, t, workspaceSlug]);

  const handleVisibility = useCallback(
    async (visibility: TReportVisibility) => {
      if (pendingAction || report?.visibility === visibility) return;
      setPendingAction("visibility");
      try {
        await research.updateReportVisibility(workspaceSlug, reportId, visibility);
        await Promise.all([research.fetchReport(workspaceSlug, reportId), research.fetchReports(workspaceSlug)]);
        setErrorKey(null);
        setToast({
          type: TOAST_TYPE.SUCCESS,
          title: t("research.feedback.visibility_updated.title"),
          message: t("research.feedback.visibility_updated.message"),
        });
      } catch (error) {
        setErrorKey(getResearchErrorKey(error));
      } finally {
        setPendingAction(null);
      }
    },
    [pendingAction, report?.visibility, reportId, research, t, workspaceSlug]
  );

  if (!report) {
    return <p className="p-5 text-13 text-tertiary">{t("research.common.loading")}</p>;
  }
  const shareTitle = [report.period_key, authorName].filter(Boolean).join(" · ") || t("research.common.untitled");

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto bg-canvas p-5">
      {errorKey && (
        <div className="rounded-md border border-danger-strong/40 bg-danger-subtle px-3 py-2 text-12 text-danger-primary">
          {t(errorKey)}
        </div>
      )}

      <ResearchDetailHeader
        title={`${report.period_key} · ${t(REPORT_TYPE_LABELS[report.report_type])}`}
        metadata={
          <>
            {authorName && <span>{t("research.reports.author", { name: authorName })}</span>}
            <span>{t(REPORT_STATUS_LABELS[report.status])}</span>
            {report.approval_route?.reviewer_detail && (
              <span>
                {t("research.reports.approval_reviewer", {
                  name: report.approval_route.reviewer_detail.display_name,
                })}
              </span>
            )}
            {readState && <span>{t(`research.reports.read.${readState}`)}</span>}
            {report.latest_read_at && (
              <span className="tabular-nums">
                {t("research.reports.read.at")} {formatResearchReadAt(report.latest_read_at, currentLocale)}
              </span>
            )}
            <span className="tabular-nums">
              {report.period_start} ~ {report.period_end}
            </span>
          </>
        }
        hint={t(`research.reports.next_step.${report.status.toLowerCase()}`)}
        actions={
          <>
            <ShareLinkIconButton
              typeLabel={t(REPORT_TYPE_LABELS[report.report_type])}
              title={shareTitle}
              href={`/${workspaceSlug}/research/reports/${reportId}`}
              ariaLabel={t("research.common.copy_share_aria", { title: shareTitle })}
            />
            {report.can_delete && (
              <ResearchDeleteButton
                name={`${report.period_key} · ${t(REPORT_TYPE_LABELS[report.report_type])}`}
                disabled={pendingAction !== null || bodyBusy}
                confirmMessage={t("research.reports.confirm_delete_restorable")}
                onDelete={async () => {
                  await research.deleteReport(workspaceSlug, reportId);
                  setToast({
                    type: TOAST_TYPE.SUCCESS,
                    title: t("research.feedback.report_deleted.title"),
                    message: t("research.feedback.report_deleted.message"),
                  });
                  navigate(`/${workspaceSlug}/research/chains?view=reports`);
                }}
              />
            )}
            {report.can_edit && (
              <Button
                variant="primary"
                size="sm"
                loading={pendingAction === "submit"}
                disabled={pendingAction !== null || bodyBusy}
                onClick={handleSubmit}
              >
                {t("research.reports.submit")}
              </Button>
            )}
            {report.can_withdraw && (
              <Button
                variant="secondary"
                size="sm"
                loading={pendingAction === "withdraw"}
                disabled={pendingAction !== null}
                onClick={() => setShowWithdraw(true)}
              >
                {t("research.reports.withdraw")}
              </Button>
            )}
            {report.can_review && report.status === "SUBMITTED" && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pendingAction !== null}
                  onClick={() => setShowReturn(true)}
                >
                  {t("research.reports.return")}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={pendingAction === "accept"}
                  disabled={pendingAction !== null}
                  onClick={() => void handleAccept()}
                >
                  {t("research.reports.accept")}
                </Button>
              </>
            )}
          </>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 xl:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {workspaceId && (
            <ReportBody
              ref={bodyRef}
              key={report.id}
              report={report}
              workspaceSlug={workspaceSlug}
              workspaceId={workspaceId}
              onBusy={setBodyBusy}
              commentAnchors={commentAnchors}
              activeThreadId={activeThreadId}
              onCreateComment={(anchor) => {
                setDraftAnchor(anchor);
                commentsPanel.openForDiscussion();
              }}
              onCommentAnchorClick={(threadId) => {
                setActiveThreadId(threadId);
                commentsPanel.openForDiscussion();
              }}
            />
          )}
          <ResearchReportAttachments
            workspaceSlug={workspaceSlug}
            reportId={reportId}
            editable={Boolean(report.can_edit)}
          />

          <ResearchDetailSurface title={t("research.reports.visibility")} collapsible>
            <div className="mt-2 flex flex-wrap gap-2">
              {visibilityOptions.map((visibility) => (
                <button
                  key={visibility}
                  type="button"
                  disabled={!report.can_edit || pendingAction !== null}
                  className={`rounded-md border px-2 py-1 text-12 disabled:cursor-not-allowed disabled:opacity-50 ${
                    effectiveVisibility === visibility
                      ? "border-accent-primary text-accent-primary"
                      : "border-subtle text-tertiary hover:text-secondary"
                  }`}
                  onClick={() => void handleVisibility(visibility)}
                >
                  {t(REPORT_VISIBILITY_LABELS[visibility])}
                </button>
              ))}
            </div>
            <p className="mt-2 text-11 text-tertiary">{t("research.reports.visibility_hint")}</p>
            {weeklyConfidential && (
              <p className="mt-1 text-11 text-tertiary">{t("research.reports.visibility_confidential_hint")}</p>
            )}
          </ResearchDetailSurface>

          <ResearchApprovalRouteDialog
            open={showSubmitRoute}
            title={t("research.reports.submit_approval_title")}
            load={loadApprovalRoute}
            submitting={pendingAction === "submit"}
            serverError={errorKey ? t(errorKey) : undefined}
            onSubmit={submitWithRoute}
            onClose={() => pendingAction === null && setShowSubmitRoute(false)}
          />

          <ModalCore isOpen={showReturn} handleClose={() => pendingAction === null && setShowReturn(false)}>
            <section className="bg-surface-1 p-5">
              <h3 className="text-13 font-medium text-primary">{t("research.reports.return_reason")}</h3>
              <p className="mt-1 text-11 text-secondary">
                {t("research.reports.return_target", {
                  from: t(REPORT_STATUS_LABELS.SUBMITTED),
                  to: t(REPORT_STATUS_LABELS.NEEDS_REVISION),
                })}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Input
                  aria-label={t("research.reports.return_reason")}
                  className="min-w-0 flex-1 sm:!w-96 sm:flex-none"
                  value={returnReason}
                  onChange={(event) => setReturnReason(event.target.value)}
                  placeholder={t("research.reports.return_placeholder")}
                />
                <Button
                  variant="primary"
                  size="sm"
                  loading={pendingAction === "return"}
                  disabled={pendingAction !== null || !returnReason.trim()}
                  onClick={() => void handleReturn()}
                >
                  {t("research.common.confirm")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pendingAction !== null}
                  onClick={() => setShowReturn(false)}
                >
                  {t("research.common.cancel")}
                </Button>
              </div>
            </section>
          </ModalCore>

          <ModalCore isOpen={showWithdraw} handleClose={() => pendingAction === null && setShowWithdraw(false)}>
            <section className="bg-surface-1 p-5">
              <h3 className="text-13 font-medium text-primary">{t("research.reports.withdraw_title")}</h3>
              <p className="mt-1 text-11 text-secondary">{t("research.reports.withdraw_hint")}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Input
                  aria-label={t("research.reports.withdraw_reason")}
                  className="min-w-0 flex-1 sm:!w-96 sm:flex-none"
                  value={withdrawReason}
                  onChange={(event) => setWithdrawReason(event.target.value)}
                  placeholder={t("research.reports.withdraw_placeholder")}
                />
                <Button
                  variant="primary"
                  size="sm"
                  loading={pendingAction === "withdraw"}
                  disabled={pendingAction !== null}
                  onClick={() => void handleWithdraw()}
                >
                  {t("research.common.confirm")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pendingAction !== null}
                  onClick={() => setShowWithdraw(false)}
                >
                  {t("research.common.cancel")}
                </Button>
              </div>
            </section>
          </ModalCore>

          <ResearchDetailSurface title={t("research.reports.history")} collapsible>
            <ol className="mt-3 flex flex-col gap-3">
              {history.map((entry) => (
                <li key={entry.id} className="flex flex-col gap-0.5 border-l border-subtle pl-3">
                  <span className="text-12 text-secondary">
                    {entry.action === "REOPEN" ? t("research.reports.history_withdraw") : entry.action} ·{" "}
                    {t(REPORT_STATUS_LABELS[entry.from_status])} → {t(REPORT_STATUS_LABELS[entry.to_status])}
                  </span>
                  <span className="text-11 text-tertiary">
                    {entry.actor_detail?.display_name ?? entry.actor_detail?.email ?? entry.actor} ·{" "}
                    {formatResearchDateTime(entry.created_at, currentLocale)}
                  </span>
                  {entry.comment && <span className="text-12 text-secondary">{entry.comment}</span>}
                </li>
              ))}
              {history.length === 0 && <li className="text-12 text-tertiary">{t("research.reports.no_history")}</li>}
            </ol>
          </ResearchDetailSurface>
        </div>
        {workspaceId && (
          <ResearchReportComments
            report={report}
            workspaceSlug={workspaceSlug}
            workspaceId={workspaceId}
            locale={currentLocale}
            draftAnchor={draftAnchor}
            onDraftConsumed={() => setDraftAnchor(null)}
            onFocusThread={(threadId) => {
              setActiveThreadId(threadId);
              return bodyRef.current?.focusComment(threadId) ?? false;
            }}
            onAnchorsChange={setCommentAnchors}
            activeThreadId={activeThreadId}
            onActiveThreadIdChange={setActiveThreadId}
            collapsed={!commentsPanel.open}
            onCollapsedChange={(collapsed) => commentsPanel.setOpen(!collapsed)}
          />
        )}
      </div>
    </div>
  );
});
