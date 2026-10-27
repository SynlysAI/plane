/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Button } from "@plane/propel/button";
import { copyTextToClipboard } from "@plane/utils";
import { configurationFiles, type MCPConfig } from "./connection-config";
import { downloadMCPConfiguration as download } from "./connection-download";
import type { MCPTarget } from "./types";

export type ConnectionResult = {
  target: MCPTarget;
  accountName: string;
  status: "success" | "failure";
  message: string;
  config?: MCPConfig;
  expires?: string;
};

export function GeneratedConnections({
  results,
  setNotice,
  clearSecrets,
}: {
  results: Record<string, ConnectionResult>;
  setNotice: (notice: string) => void;
  clearSecrets: () => void;
}) {
  const configs = Object.values(results).flatMap((result) => (result.config ? [result.config] : []));
  const files = configurationFiles(configs);
  const successful = Object.values(results).filter((result) => result.status === "success").length;
  const failures = Object.values(results).filter((result) => result.status === "failure").length;
  return (
    <>
      {Object.keys(results).length > 0 && (
        <section aria-label="批量生成结果" className="space-y-4 rounded-xl border border-subtle p-4 sm:p-5">
          <h2 className="text-16 font-semibold">
            本次生成结果：{successful} 成功、{failures} 失败
          </h2>
          {Object.entries(results).map(([key, result]) => (
            <p key={key} role={result.status === "failure" ? "alert" : "status"}>
              账号：{result.accountName} ·{" "}
              {result.target.mode === "read"
                ? "只读"
                : result.target.source === "admin"
                  ? "读写（进展发布）"
                  : "读写（受控）"}{" "}
              · 到期时间：
              {result.expires ?? (result.status === "failure" ? "未签发" : "未提供")}
              {result.message !== "已生成" && ` · ${result.message}`}
            </p>
          ))}
          {configs.length > 0 && (
            <>
              <p>
                密钥仅本次展示。关闭结果、修改目标或退出验证后清除。配置包含多个命名服务项，各自使用独立地址及密钥。
              </p>
              <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                <label className="block min-w-0">
                  Codex TOML
                  <textarea
                    aria-label="批量 TOML 配置"
                    readOnly
                    className="font-mono mt-1 h-48 w-full rounded border border-subtle bg-surface-1 p-3"
                    value={files.toml}
                  />
                </label>
                <label className="block min-w-0">
                  通用 MCP JSON
                  <textarea
                    aria-label="批量 JSON 配置"
                    readOnly
                    className="font-mono mt-1 h-48 w-full rounded border border-subtle bg-surface-1 p-3"
                    value={files.json}
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="secondary"
                  onClick={() =>
                    void copyTextToClipboard(files.toml).then(
                      () => setNotice("配置已复制。"),
                      () => setNotice("复制失败，请手动选择配置。")
                    )
                  }
                >
                  复制 TOML
                </Button>
                <Button variant="secondary" onClick={() => download(files.toml, "toml")}>
                  导出 TOML
                </Button>
                <Button variant="secondary" onClick={() => download(files.json, "json")}>
                  导出 JSON
                </Button>
              </div>
            </>
          )}
          <Button variant="secondary" onClick={clearSecrets}>
            关闭生成结果并清除密钥
          </Button>
        </section>
      )}
    </>
  );
}
