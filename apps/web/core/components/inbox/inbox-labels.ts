/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export const INBOX_KIND_LABELS: Record<string, string> = {
  notification: "通知",
  todo: "待办",
  reminder: "提醒",
  system: "系统",
};

export const INBOX_CATEGORY_LABELS: Record<string, string> = {
  mention: "@ 我",
  todo: "待办",
  approval: "审批",
  review: "评审",
  work_item: "工作项",
  system: "系统",
};

export const INBOX_SOURCE_LABELS: Record<string, string> = {
  issue: "工作项",
  system_announcement: "系统公告",
  research_report: "科研报告",
  research_approval: "科研审批",
  research_chain_task: "科研任务",
  research_paper_review: "论文评审",
  research_stage_review: "阶段评审",
  research_stage: "科研阶段",
  research_experiment: "实验记录",
  research_experiment_amendment: "实验修订",
  research_feedback: "平台反馈",
  user_mention: "用户提及",
  CHAIN_TASK: "科研任务",
  REPORT: "科研报告",
  PAPER_REVIEW: "论文评审",
  STAGE_REVIEW: "阶段评审",
  CHAIN_STAGE_APPROVAL: "阶段审批",
  AGENT_APPROVAL: "智能体审批",
  OFFICE_APPROVAL: "行政审批",
};

export const INBOX_URGENCY_LABELS: Record<string, string> = {
  OVERDUE: "已逾期",
  DUE_TODAY: "今天截止",
  DUE_SOON: "即将截止",
  NORMAL: "常规",
};

export const INBOX_ACTION_LABELS: Record<string, string> = {
  READ: "阅读",
  REVIEW: "评审",
  SUBMIT: "提交",
  ASSIGN: "指派",
  RETURN: "退回",
  ACCEPT: "接受",
  WITHDRAW: "撤回",
  COMPLETE: "完成",
  REOPEN: "标记未完成",
  CANCEL: "取消",
  APPROVE: "批准",
  REJECT: "驳回",
};

export const INBOX_STATUS_LABELS: Record<string, string> = {
  DRAFT: "草稿",
  ASSIGNED: "已指派",
  SUBMITTED: "已提交",
  NEEDS_REVISION: "需修订",
  WAITING_REVIEW: "待评审",
  WAITING_APPROVAL: "待审批",
  PENDING: "待处理",
  APPROVED: "已批准",
  REJECTED: "已驳回",
  CANCELLED: "已取消",
};

/** Resolve a label with a safe fallback to the raw stable identifier. */
export function inboxLabel(labels: Record<string, string>, value: string | undefined) {
  return value ? (labels[value] ?? value) : undefined;
}
