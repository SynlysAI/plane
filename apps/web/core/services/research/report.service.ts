/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL, researchEndpoints } from "@plane/constants";
import type {
  TPeriodicReport,
  TResearchApprovalRoute,
  TPaginationInfo,
  TReportAttachment,
  TReportComment,
  TReportCommentFeedback,
  TReportCommentThread,
  TReportCommentThreadList,
  TReportReadReceipt,
  TReportReadResult,
  TReportReviewLog,
  TReportSelectionAnchor,
  TReportSummary,
  TReportTemplate,
  TReportTemplateOption,
  TReportTemplateSections,
  TSearchResponse,
} from "@plane/types";
// services
import { APIService } from "@/services/api.service";

export type TReportListParams = {
  q?: string;
  scope?: string;
  period_key?: string;
  status?: string;
  report_type?: string;
  org_unit?: string;
  owner?: string;
  date_from?: string;
  date_to?: string;
  mine?: string;
  cursor?: string;
  per_page?: string;
};

export type TReportCreatePayload = {
  report_type: string;
  period_key?: string;
  team_projects?: string[];
  template?: string | null;
  visibility?: string;
  is_backfill?: boolean;
};

export type TReportCommentThreadCreatePayload = {
  anchor?: TReportSelectionAnchor | null;
  comment_html: string;
  request_id: string;
};

export type TReportCommentCreatePayload = {
  comment_html: string;
  parent?: string | null;
  request_id: string;
};

export class ResearchReportService extends APIService {
  async deleteReport(workspaceSlug: string, reportId: string) {
    return this.delete(researchEndpoints.report(workspaceSlug, reportId)).catch((error) => {
      throw error?.response?.data ?? error;
    });
  }

  /** 恢复误删的周期报告及其同批正文、引用和附件。 */
  async restoreReport(workspaceSlug: string, reportId: string) {
    return this.post(researchEndpoints.reportRestore(workspaceSlug, reportId), {})
      .then((res) => res?.data as TPeriodicReport)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }
  constructor() {
    super(API_BASE_URL);
  }

  async getReports(workspaceSlug: string, params: TReportListParams = {}) {
    return this.get(researchEndpoints.reports(workspaceSlug), { params })
      .then((res) => res?.data as TPaginationInfo & { results: TPeriodicReport[] })
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async createReport(workspaceSlug: string, payload: TReportCreatePayload) {
    return this.post(researchEndpoints.reports(workspaceSlug), payload)
      .then((res) => res?.data as TPeriodicReport)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async getReport(workspaceSlug: string, reportId: string) {
    return this.get(researchEndpoints.report(workspaceSlug, reportId))
      .then((res) => res?.data as TPeriodicReport)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async updateReport(
    workspaceSlug: string,
    reportId: string,
    payload:
      | Partial<TPeriodicReport>
      | { description_json: object; description_html: string; description_binary?: string }
  ) {
    return this.patch(researchEndpoints.report(workspaceSlug, reportId), payload)
      .then((res) => res?.data as TPeriodicReport)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async submitReport(
    workspaceSlug: string,
    reportId: string,
    payload: {
      comment?: string;
      description_json?: object;
      description_html?: string;
      reviewer_id?: string;
      cc_user_ids?: string[];
    } = {}
  ) {
    return this.post(researchEndpoints.reportSubmit(workspaceSlug, reportId), payload)
      .then((res) => res?.data as TPeriodicReport)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  /** 读取周报/月报提交审批路由候选组。 */
  async getApprovalRoute(workspaceSlug: string, reportId: string) {
    return this.get(researchEndpoints.reportApprovalRoute(workspaceSlug, reportId))
      .then((res) => {
        const payload = res?.data as { data?: TResearchApprovalRoute } | undefined;
        if (!payload?.data) throw payload ?? {};
        return payload.data;
      })
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  /** 撤回当前已提交报告，让作者回到草稿继续编辑。 */
  async withdrawReport(workspaceSlug: string, reportId: string, comment = "") {
    return this.post(researchEndpoints.reportWithdraw(workspaceSlug, reportId), { comment })
      .then((res) => res?.data as TPeriodicReport)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async returnReport(workspaceSlug: string, reportId: string, comment: string) {
    return this.post(researchEndpoints.reportReturn(workspaceSlug, reportId), { comment })
      .then((res) => res?.data as TPeriodicReport)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async acceptReport(workspaceSlug: string, reportId: string, comment = "") {
    return this.post(researchEndpoints.reportAccept(workspaceSlug, reportId), { comment })
      .then((res) => res?.data as TPeriodicReport)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async getReportHistory(workspaceSlug: string, reportId: string) {
    return this.get(researchEndpoints.reportHistory(workspaceSlug, reportId))
      .then((res) => res?.data as { results: TReportReviewLog[]; count: number })
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  /** Search report-visible members for report discussion mentions. */
  async getReportCommentMentions(workspaceSlug: string, reportId: string, query: string, count = 5) {
    return this.get(researchEndpoints.reportCommentMentions(workspaceSlug, reportId), { params: { query, count } })
      .then((res) => res?.data as TSearchResponse)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async getReportCommentThreads(workspaceSlug: string, reportId: string, status: "OPEN" | "RESOLVED" | "ALL" = "OPEN") {
    return this.get(researchEndpoints.reportCommentThreads(workspaceSlug, reportId), { params: { status } })
      .then((res) => res?.data as TReportCommentThreadList)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async createReportCommentThread(workspaceSlug: string, reportId: string, payload: TReportCommentThreadCreatePayload) {
    return this.post(researchEndpoints.reportCommentThreads(workspaceSlug, reportId), payload)
      .then((res) => res?.data as TReportCommentThread)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async createReportCommentReply(
    workspaceSlug: string,
    reportId: string,
    threadId: string,
    payload: TReportCommentCreatePayload
  ) {
    return this.post(researchEndpoints.reportCommentThreadComments(workspaceSlug, reportId, threadId), payload)
      .then((res) => res?.data as TReportComment)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async updateReportComment(
    workspaceSlug: string,
    reportId: string,
    commentId: string,
    payload: Partial<Pick<TReportComment, "comment_html">>
  ) {
    return this.patch(researchEndpoints.reportComment(workspaceSlug, reportId, commentId), payload)
      .then((res) => res?.data as TReportComment)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async deleteReportComment(workspaceSlug: string, reportId: string, commentId: string) {
    return this.delete(researchEndpoints.reportComment(workspaceSlug, reportId, commentId)).catch((err) => {
      throw err?.response?.data;
    });
  }

  async updateReportCommentThreadStatus(
    workspaceSlug: string,
    reportId: string,
    threadId: string,
    status: TReportCommentThread["status"]
  ) {
    return this.post(researchEndpoints.reportCommentThreadStatus(workspaceSlug, reportId, threadId), { status })
      .then((res) => res?.data as TReportCommentThread)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async submitReportCommentFeedback(workspaceSlug: string, reportId: string, commentId: string) {
    return this.post(researchEndpoints.reportCommentFeedback(workspaceSlug, reportId, commentId), {})
      .then((res) => res?.data as TReportCommentFeedback)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async markReportRead(workspaceSlug: string, reportId: string) {
    return this.post(researchEndpoints.reportRead(workspaceSlug, reportId), {})
      .then((res) => res?.data as TReportReadResult)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async getReportReadReceipts(workspaceSlug: string, reportId: string) {
    return this.get(researchEndpoints.reportReadReceipts(workspaceSlug, reportId))
      .then((res) => res?.data as { results: TReportReadReceipt[]; count: number })
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async getReportAccess(workspaceSlug: string, reportId: string) {
    return this.get(researchEndpoints.reportAccess(workspaceSlug, reportId))
      .then((res) => res?.data)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async updateReportAccess(
    workspaceSlug: string,
    reportId: string,
    payload: { visibility?: string; grants?: { grantee_user?: string; grantee_org_unit?: string }[] }
  ) {
    return this.patch(researchEndpoints.reportAccess(workspaceSlug, reportId), payload)
      .then((res) => res?.data)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async getReportAttachments(workspaceSlug: string, reportId: string) {
    return this.get(researchEndpoints.reportAttachments(workspaceSlug, reportId))
      .then((res) => res?.data as { results: TReportAttachment[]; count: number })
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async registerReportAttachment(
    workspaceSlug: string,
    reportId: string,
    payload: { asset_id: string; kind?: string; file_name?: string }
  ) {
    return this.post(researchEndpoints.reportAttachments(workspaceSlug, reportId), payload)
      .then((res) => res?.data as TReportAttachment)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async presignReportAttachment(
    workspaceSlug: string,
    reportId: string,
    payload: { file_name: string; content_type: string; size: number }
  ) {
    return this.post(`${researchEndpoints.reportAttachments(workspaceSlug, reportId)}presign/`, payload)
      .then(
        (res) =>
          res?.data as {
            asset_id: string;
            asset_key: string;
            upload_data: { url: string; fields: Record<string, string> };
          }
      )
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async deleteReportAttachment(workspaceSlug: string, reportId: string, attachmentId: string) {
    return this.delete(researchEndpoints.reportAttachment(workspaceSlug, reportId, attachmentId))
      .then((res) => res?.data)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async importMarkdown(workspaceSlug: string, reportId: string, payload: { content: string; file_name?: string }) {
    return this.post(researchEndpoints.reportImportMarkdown(workspaceSlug, reportId), payload)
      .then((res) => res?.data as TPeriodicReport)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  /** 导出包含正文图片的 Markdown ZIP，并解析 Blob 形式的错误响应。 */
  async exportMarkdown(workspaceSlug: string, reportId: string, content: string) {
    try {
      const response = await this.post(
        researchEndpoints.reportExportMarkdown(workspaceSlug, reportId),
        { content },
        { responseType: "blob" }
      );
      return response?.data as Blob;
    } catch (error) {
      const data = (error as { response?: { data?: unknown } })?.response?.data;
      if (data instanceof Blob && data.type.includes("application/json")) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await data.text());
        } catch (parseError) {
          if (parseError instanceof SyntaxError) throw data;
        }
        throw parsed;
      }
      throw data ?? error;
    }
  }

  async getSummary(
    workspaceSlug: string,
    params: { period_key?: string; period_offset?: number; report_type?: string; org_unit?: string } = {}
  ) {
    return this.get(researchEndpoints.reportSummary(workspaceSlug), { params })
      .then((res) => res?.data as TReportSummary)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async getTemplates(
    workspaceSlug: string,
    params: {
      scope?: string;
      report_type?: string;
      stage?: string;
      material_type?: string;
      include_inactive?: string;
    } = {}
  ) {
    return this.get(researchEndpoints.reportTemplates(workspaceSlug), { params })
      .then((res) => res?.data as { results: TReportTemplate[]; count: number })
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  /** Read the minimal active template options for report creation. */
  async getTemplateOptions(workspaceSlug: string, params: { report_type?: string } = {}) {
    return this.get(researchEndpoints.reportTemplateOptions(workspaceSlug), { params })
      .then((res) => res?.data as { results: TReportTemplateOption[]; count: number })
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async createTemplate(
    workspaceSlug: string,
    payload: {
      name: string;
      scope?: string;
      report_type?: string;
      stage?: string;
      material_type?: string;
      content_json?: Record<string, unknown>;
      sections_json?: TReportTemplateSections;
      is_default?: boolean;
      is_active?: boolean;
    }
  ) {
    return this.post(researchEndpoints.reportTemplates(workspaceSlug), payload)
      .then((res) => res?.data as TReportTemplate)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async updateTemplate(workspaceSlug: string, templateId: string, payload: Partial<TReportTemplate>) {
    return this.patch(researchEndpoints.reportTemplate(workspaceSlug, templateId), payload)
      .then((res) => res?.data as TReportTemplate)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async deleteTemplate(workspaceSlug: string, templateId: string) {
    return this.delete(researchEndpoints.reportTemplate(workspaceSlug, templateId))
      .then((res) => res?.data)
      .catch((err) => {
        throw err?.response?.data;
      });
  }
}
