/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Button } from "@plane/propel/button";
import { actionLabels } from "./connection-config";
import type { NativeState } from "./mcp-services";
import type { MCPTarget } from "./types";

const inputClass = "rounded border border-subtle bg-surface-1 px-3 py-2";
function capabilities(target: MCPTarget) {
  return target.mode === "read"
    ? "只读"
    : target.source === "admin"
      ? "读取与进展发布"
      : `读取与受控写入${target.actions.map((action) => `、${actionLabels[action] ?? action}`).join("")}`;
}

export function AuthorizationSummary({
  targets,
  native,
  name,
  setName,
  days,
  setDays,
  busy,
  failures,
  validDays,
  canGenerate,
  generate,
}: {
  targets: MCPTarget[];
  native: NativeState;
  name: string;
  setName: (name: string) => void;
  days: string;
  setDays: (days: string) => void;
  busy: boolean;
  failures: number;
  validDays: boolean;
  canGenerate: boolean;
  generate: () => Promise<void>;
}) {
  return (
    <section
      aria-label="授权摘要"
      className="space-y-4 rounded-lg border border-subtle bg-surface-2 p-4 xl:sticky xl:top-4"
    >
      <h3 className="text-16 font-semibold">授权摘要</h3>
      <p>
        已选择 {new Set(targets.map((target) => `${target.source}:${target.workspace}`)).size} 个来源工作区、
        {targets.filter((target) => target.source === "research").length} 个科研节点，共 {targets.length} 条独立连接。
      </p>
      {targets.length === 0 && <p className="text-secondary">请选择需要访问的工作区或科研节点。</p>}
      <ul className="max-h-56 space-y-2 overflow-y-auto text-secondary">
        {targets.map((target) => (
          <li key={target.key}>
            {target.workspaceName} · {target.source === "admin" ? "行政" : `科研 ${target.chainTitle} /`} {target.title}{" "}
            · {capabilities(target)}
          </li>
        ))}
      </ul>
      <p>
        科研写入在 Codex 等 Agent 客户端确认后提交，平台校验权限并执行，无需再次审批。连接仅允许所选节点和写入能力。
      </p>
      <label className="block">
        连接名称
        <input
          aria-label="连接名称"
          className={`mt-1 block w-full ${inputClass}`}
          maxLength={64}
          disabled={busy}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {targets.some((target) => target.source === "admin") && (
        <label className="block">
          行政连接有效天数（最长 {native.options?.max_token_days} 天）
          <input
            aria-label="行政连接有效天数"
            className={`mt-1 block w-24 ${inputClass}`}
            type="number"
            min={1}
            max={native.options?.max_token_days}
            disabled={busy}
            value={days}
            onChange={(event) => setDays(event.target.value)}
          />
        </label>
      )}
      {targets.some((target) => target.source === "admin") && !validDays && (
        <p role="alert">请输入 1 至 {native.options?.max_token_days} 之间的整数天数。</p>
      )}
      {targets.some((target) => target.source === "research") && (
        <p>
          科研节点有效期由服务端固定：
          {[...new Set(targets.flatMap((target) => (target.source === "research" ? [target.ttlSeconds] : [])))].join(
            " / "
          )}{" "}
          秒。下方生成结果显示实际到期时间。
        </p>
      )}
      <Button className="w-full" disabled={busy || !canGenerate} onClick={() => void generate()}>
        {busy ? "正在处理…" : failures ? "重试未成功目标" : "批量生成独立连接"}
      </Button>
    </section>
  );
}
