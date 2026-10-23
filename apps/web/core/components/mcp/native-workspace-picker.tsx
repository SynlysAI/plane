/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { NativeState } from "./mcp-services";
import type { MCPTarget } from "./types";

export function NativeWorkspacePicker({
  native,
  query,
  selected,
  busy,
  select,
}: {
  native: NativeState;
  query: string;
  selected: Record<string, MCPTarget>;
  busy: boolean;
  select: (targets: MCPTarget[], remove?: boolean) => void;
}) {
  return (
    <>
      {native.session &&
        native.candidates?.workspaces.flatMap((slug) => {
          if (query && !slug.toLowerCase().includes(query.toLowerCase())) return [];
          // Keep successful receipts across session renewal, but never across
          // independent portal identities or instances with the same workspace name.
          const key = `admin:${native.options?.plane_ui_url ?? native.options?.portal_url}:${native.candidates!.account.id}:${slug}`;
          const target: MCPTarget = {
            key,
            source: "admin",
            workspace: slug,
            workspaceName: `${slug} · 行政账号 ${native.session!.name}`,
            title: "行政项目访问",
            mode: "read",
            actions: [],
            csrf: native.options!.csrf_token,
          };
          const chosen = selected[key];
          return (
            <section key={key} className="space-y-3 rounded border border-subtle p-4">
              <h4 className="font-medium">
                {slug} · 行政来源 {native.options?.plane_ui_url} · {native.session?.name}
              </h4>
              <label className="block">
                <input
                  aria-label={`行政项目访问 ${slug}`}
                  type="checkbox"
                  disabled={busy}
                  checked={Boolean(chosen)}
                  onChange={() => select([target], Boolean(chosen))}
                />{" "}
                行政项目访问（读取）
              </label>
              {chosen && native.options?.allow_publish && (
                <label className="block pl-5">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={chosen.mode === "write"}
                    onChange={(event) => select([{ ...chosen, mode: event.target.checked ? "write" : "read" }])}
                  />{" "}
                  允许准备并发布行政进展评论
                </label>
              )}
            </section>
          );
        })}
    </>
  );
}
