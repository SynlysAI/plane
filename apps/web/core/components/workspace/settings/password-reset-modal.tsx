/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { FormEvent } from "react";
import { useState } from "react";
import { Button } from "@plane/propel/button";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { AuthService } from "@/services/auth.service";
import { WorkspaceService } from "@/services/workspace.service";

const workspaceService = new WorkspaceService();
const authService = new AuthService();

type Props = {
  workspaceSlug: string;
  user: { id: string; email?: string; display_name?: string };
  onClose: () => void;
};

/** 核验管理员身份后发放临时密码，关闭对话框时由父组件卸载凭据状态。 */
export function WorkspacePasswordResetModal({ workspaceSlug, user, onClose }: Props) {
  const [verified, setVerified] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");

  /** 验证当前操作者密码并申请一次临时密码，失败时保留表单以便重试。 */
  const handleReset = async (event: FormEvent) => {
    event.preventDefault();
    if (!verified || !currentPassword || submitting || temporaryPassword) return;
    setSubmitting(true);
    setError("");
    try {
      const { csrf_token: csrfToken } = await authService.requestCSRFToken();
      const response = await workspaceService.resetMemberPassword(workspaceSlug, user.id, currentPassword, csrfToken);
      setTemporaryPassword(response.temporary_password);
      setCurrentPassword("");
    } catch (failure) {
      const payload = failure as { error?: string; detail?: string } | undefined;
      setError(payload?.error || payload?.detail || "重置失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  };

  /** 复制待发给用户的凭据；剪贴板不可用时保留可选中的密码。 */
  const copyCredential = async () => {
    try {
      await navigator.clipboard.writeText(
        `PiLab 登录邮箱：${user.email}\n临时密码：${temporaryPassword}\n下次登录必须修改密码。`
      );
      setCopyStatus("已复制，请通过核验过的渠道单独发给本人。");
    } catch {
      setCopyStatus("无法自动复制，请手动选择并复制临时密码。");
    }
  };

  return (
    <ModalCore
      isOpen
      handleClose={() => {
        if (!submitting) onClose();
      }}
      position={EModalPosition.CENTER}
      width={EModalWidth.XXL}
    >
      <div className="space-y-4 p-6">
        <h2 className="text-16 font-semibold text-primary">重置成员密码</h2>
        <div className="text-13 text-secondary">
          <p>{user.display_name}</p>
          <p className="break-all">{user.email}</p>
        </div>
        {temporaryPassword ? (
          <div className="space-y-4">
            <p className="text-12 leading-relaxed text-secondary">
              重置成功，原密码及现有会话已失效。下次登录必须修改密码。临时密码仅在此处展示，关闭后无法再次查看。
            </p>
            <label className="block space-y-2 text-12 text-secondary">
              <span>临时密码</span>
              <input
                readOnly
                value={temporaryPassword}
                onFocus={(event) => event.target.select()}
                className="font-mono w-full rounded-md border border-subtle bg-surface-1 px-3 py-2 text-13 text-primary"
              />
            </label>
            <p role="status" className="text-12 text-secondary">
              {copyStatus}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="lg" onClick={() => void copyCredential()}>
                复制登录信息
              </Button>
              <Button variant="primary" size="lg" onClick={onClose}>
                完成
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={(event) => void handleReset(event)} className="space-y-4">
            <p className="text-12 leading-relaxed text-secondary">
              此操作会更换该账号在所有工作区的登录密码，并退出已有会话。请先通过已知渠道核验本人身份。
            </p>
            <label className="flex items-start gap-2 text-12 text-secondary">
              <input
                type="checkbox"
                checked={verified}
                onChange={(event) => setVerified(event.target.checked)}
                className="mt-0.5"
                disabled={submitting}
              />
              <span>我已核验该成员身份，确认需要重置密码。</span>
            </label>
            <label className="block space-y-2 text-12 text-secondary">
              <span>管理员当前密码</span>
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                disabled={submitting}
                className="w-full rounded-md border border-subtle bg-surface-1 px-3 py-2 text-13 text-primary"
                required
              />
            </label>
            {error && (
              <p role="alert" className="text-12 text-danger-primary">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="lg" onClick={onClose} disabled={submitting}>
                取消
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="lg"
                disabled={!verified || !currentPassword || submitting}
                loading={submitting}
              >
                生成临时密码
              </Button>
            </div>
          </form>
        )}
      </div>
    </ModalCore>
  );
}
