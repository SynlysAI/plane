/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearchParams } from "react-router";

import { API_BASE_URL } from "@plane/constants";

type UserPreview = {
  id: string;
  display_name: string;
};

type AssignmentTransferPreview = {
  status: "ready" | "already_completed" | "completed";
  entity_type: "administrative_work_item" | "research_work_item";
  title: string;
  workspace_slug: string;
  route: string;
  expires_at: string;
  current_assignee?: UserPreview;
  candidate?: UserPreview;
};

type AssignmentTransferError = {
  error_code: string;
  message: string;
  route?: string;
};

type ViewState =
  | { kind: "loading" }
  | { kind: "ready"; data: AssignmentTransferPreview }
  | { kind: "submitting"; data: AssignmentTransferPreview }
  | { kind: "done"; data: AssignmentTransferPreview }
  | { kind: "error"; error: AssignmentTransferError; needsLogin: boolean };

const ENTITY_LABELS: Record<AssignmentTransferPreview["entity_type"], string> = {
  administrative_work_item: "行政工作项",
  research_work_item: "科研工作项",
};

function absoluteRoute(route: string): string {
  if (!route) return "/";
  return new URL(route, window.location.origin).href;
}

function formatExpiry(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

async function requestPreview(token: string, candidate: string, method: "GET" | "POST") {
  const response = await fetch(`${API_BASE_URL}/api/email-actions/assignment-transfer/`, {
    method,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify({ token, candidate_id: candidate }) } : {}),
  });

  const payload = await response.json().catch(() => ({}));
  return { response, payload } as {
    response: Response;
    payload: AssignmentTransferPreview & Partial<AssignmentTransferError>;
  };
}

export function AssignmentTransferConfirmation() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const token = searchParams.get("token") ?? "";
  const candidate = searchParams.get("candidate") ?? "";
  const [state, setState] = useState<ViewState>({ kind: "loading" });

  useEffect(() => {
    if (!token || !candidate) {
      setState({
        kind: "error",
        error: { error_code: "assignment_transfer_invalid", message: "转派链接无效。" },
        needsLogin: false,
      });
      return;
    }

    let cancelled = false;
    void requestPreview(token, candidate, "GET")
      .then(({ response, payload }) => {
        if (cancelled) return undefined;
        if (response.ok) {
          setState({ kind: "ready", data: payload });
          return undefined;
        }
        setState({
          kind: "error",
          error: {
            error_code: payload.error_code ?? "assignment_transfer_failed",
            message: payload.message ?? "无法加载转派信息。",
            route: payload.route,
          },
          needsLogin: response.status === 401,
        });
        return undefined;
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            kind: "error",
            error: { error_code: "network_error", message: "网络异常，请稍后重试。" },
            needsLogin: false,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [candidate, token]);

  const loginHref = useMemo(() => {
    const current = `${location.pathname}${location.search}`;
    return `/?next_path=${encodeURIComponent(current)}`;
  }, [location.pathname, location.search]);

  const confirm = async () => {
    if (state.kind !== "ready") return;
    setState({ kind: "submitting", data: state.data });
    try {
      const { response, payload } = await requestPreview(token, candidate, "POST");
      if (response.ok) {
        setState({ kind: "done", data: payload });
        return;
      }
      setState({
        kind: "error",
        error: {
          error_code: payload.error_code ?? "assignment_transfer_failed",
          message: payload.message ?? "转派未完成，请到原生网页处理。",
          route: payload.route,
        },
        needsLogin: response.status === 401,
      });
    } catch {
      setState({
        kind: "error",
        error: { error_code: "network_error", message: "网络异常，请稍后重试。" },
        needsLogin: false,
      });
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#F7F7F5] px-4 py-10">
      <section className="w-full max-w-[560px] border border-[#E5E5DF] bg-white px-8 py-9 sm:px-10">
        {state.kind === "loading" && (
          <>
            <p className="text-xs font-semibold tracking-wide text-[#92928B]">正在校验转派链接</p>
            <p className="text-sm mt-3 text-[#6D6D67]">请稍候，我们正在确认工作项和候选负责人。</p>
          </>
        )}

        {state.kind === "ready" && (
          <>
            <p className="text-xs font-semibold tracking-wide text-[#92928B]">
              {ENTITY_LABELS[state.data.entity_type]}负责人转派
            </p>
            <h1 className="text-2xl mt-3 leading-snug font-semibold text-[#252522]">{state.data.title}</h1>
            <div className="text-sm mt-7 space-y-3 border-t border-[#F1F1ED] pt-6 text-[#252522]">
              <p>
                <span className="mr-3 text-[#6D6D67]">当前负责人</span>
                {state.data.current_assignee?.display_name ?? "—"}
              </p>
              <p>
                <span className="mr-3 text-[#6D6D67]">下一位负责人</span>
                <strong>{state.data.candidate?.display_name ?? "—"}</strong>
              </p>
              <p>
                <span className="mr-3 text-[#6D6D67]">链接有效期</span>
                {formatExpiry(state.data.expires_at)}
              </p>
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={state.kind !== "ready"}
                className="text-sm rounded-[6px] bg-[#426B67] px-4 py-2.5 font-semibold text-white transition-colors hover:bg-[#385B58] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#426B67] focus-visible:ring-offset-2 disabled:opacity-60"
              >
                确认转派
              </button>
              <a
                href={absoluteRoute(state.data.route)}
                className="text-sm rounded-[6px] border border-[#E5E5DF] px-4 py-2.5 font-medium text-[#252522] transition-colors hover:bg-[#F5F5F1]"
              >
                先查看工作项
              </a>
            </div>
          </>
        )}

        {state.kind === "submitting" && (
          <>
            <p className="text-xs font-semibold tracking-wide text-[#92928B]">正在提交</p>
            <p className="text-sm mt-3 text-[#6D6D67]">正在把工作项转派给 {state.data.candidate?.display_name}。</p>
          </>
        )}

        {state.kind === "done" && (
          <>
            <p className="text-xs font-semibold tracking-wide text-[#426B67]">转派完成</p>
            <h1 className="text-2xl mt-3 leading-snug font-semibold text-[#252522]">{state.data.title}</h1>
            <p className="text-sm mt-4 leading-6 text-[#6D6D67]">
              该{ENTITY_LABELS[state.data.entity_type]}已由 {state.data.current_assignee?.display_name} 转派给{" "}
              {state.data.candidate?.display_name}。新负责人会收到下一封指派通知。
            </p>
            <a
              href={absoluteRoute(state.data.route)}
              className="text-sm mt-8 inline-block rounded-[6px] bg-[#426B67] px-4 py-2.5 font-semibold text-white transition-colors hover:bg-[#385B58]"
            >
              查看工作项
            </a>
          </>
        )}

        {state.kind === "error" && (
          <>
            <p className="text-xs font-semibold tracking-wide text-[#92928B]">无法完成转派</p>
            <h1 className="text-xl mt-3 leading-snug font-semibold text-[#252522]">{state.error.message}</h1>
            <p className="text-sm mt-4 leading-6 text-[#6D6D67]">
              {state.needsLogin
                ? "该操作需要邮件接收人本人登录。登录后会自动返回本确认页。"
                : "你可以回到原生网页检查当前负责人，并重新选择转派对象。"}
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              {state.needsLogin && (
                <a
                  href={loginHref}
                  className="text-sm rounded-[6px] bg-[#426B67] px-4 py-2.5 font-semibold text-white transition-colors hover:bg-[#385B58]"
                >
                  去登录
                </a>
              )}
              {state.error.route && (
                <a
                  href={absoluteRoute(state.error.route)}
                  className="text-sm rounded-[6px] border border-[#E5E5DF] px-4 py-2.5 font-medium text-[#252522] transition-colors hover:bg-[#F5F5F1]"
                >
                  打开原生网页
                </a>
              )}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
