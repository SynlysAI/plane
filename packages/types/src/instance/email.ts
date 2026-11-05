/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export type TInstanceEmailConfigurationKeys =
  | "EMAIL_HOST"
  | "EMAIL_PORT"
  | "EMAIL_HOST_USER"
  | "EMAIL_HOST_PASSWORD"
  | "EMAIL_USE_TLS"
  | "EMAIL_USE_SSL"
  | "EMAIL_FROM"
  | "ENABLE_SMTP";

/** 邮箱过滤规则；ID 在编辑和重新排序时保持不变。 */
export type TEmailRecipientFilterRule = {
  id: string;
  type: "email" | "domain";
  value: string;
  note: string;
  enabled: boolean;
};

/** 实例级邮件过滤策略，关闭或空列表均表示不屏蔽。 */
export type TEmailRecipientFilterPolicy = {
  enabled: boolean;
  rules: TEmailRecipientFilterRule[];
};

export type TEmailRecipientFilterCheck = {
  email: string;
  blocked: boolean;
  matched_rule: TEmailRecipientFilterRule | null;
};
