/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useId, useState } from "react";

const ADMIN_CONTACT_EMAIL = "fangyikai@xmu.edu.cn";

/** 展示人工账号恢复渠道，不依赖站点的邮件发送服务。 */
export function ForgotPasswordPopover({ email = "" }: { email?: string }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "manual">("idle");
  const message = `PiLab 账号恢复申请\n登录邮箱：${email || "不记得"}\n姓名：\n课题组／工作区：\n请核验身份后协助确认账号或重置密码。`;
  const contactHref = `mailto:${ADMIN_CONTACT_EMAIL}?subject=${encodeURIComponent("PiLab 账号恢复申请")}&body=${encodeURIComponent(message)}`;

  /** 复制求助信息；浏览器不允许访问剪贴板时展示可手动复制的文本。 */
  const copyRequest = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("manual");
    }
  };

  return (
    <div className="w-full">
      <button
        type="button"
        className="text-12 font-medium text-accent-primary underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-offset-2"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        联系管理员重置
      </button>
      {open && (
        <section
          id={panelId}
          aria-label="联系管理员恢复账号"
          className="mt-3 space-y-3 border-l border-subtle pl-3 text-12 leading-relaxed text-secondary"
        >
          <p>忘记密码或登录邮箱时，请联系管理员核验身份。请提供姓名、课题组及登录邮箱（如记得）。</p>
          <a href={contactHref} className="block break-all text-accent-primary underline-offset-4 hover:underline">
            {ADMIN_CONTACT_EMAIL}
          </a>
          <p>管理员核验后可在“工作区设置 → 成员”中重置。收到临时密码后，下次登录需设置新密码。</p>
          <button
            type="button"
            onClick={() => void copyRequest()}
            className="text-primary underline underline-offset-4"
          >
            {copyStatus === "copied" ? "已复制" : "复制求助信息"}
          </button>
          <p role="status" className="text-11 text-tertiary">
            {copyStatus === "copied"
              ? "已复制，请通过邮件或已有联系渠道发给管理员。"
              : "点击邮箱将打开本机邮件应用；此入口不会自动提交申请。"}
          </p>
          {copyStatus === "manual" && (
            <textarea
              aria-label="求助信息，请手动复制"
              readOnly
              value={message}
              rows={6}
              className="w-full rounded-md border border-subtle bg-surface-1 p-2 text-12 text-primary"
            />
          )}
        </section>
      )}
    </div>
  );
}
