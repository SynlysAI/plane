import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";

import { AssignmentTransferConfirmation } from "@/components/email-actions/assignment-transfer-confirmation";
// oxlint-disable-next-line import/no-unassigned-import -- Use app styles in browser verification.
import "../../styles/globals.css";

const options = new URLSearchParams(window.location.search);
const scenario = options.get("scenario") ?? "ready";
const preview = {
  status: "ready",
  entity_type: "research_work_item",
  title: "JACS 审稿意见回复",
  workspace_slug: "lab",
  route: "/lab/research/chains/chain-1?node=node-1&task=task-1",
  expires_at: "2026-11-12T03:00:00.000Z",
  current_assignee: { id: "owner", display_name: "当前负责人" },
  candidate: {
    id: "next",
    display_name: options.has("long") ? "跨学科联合实验室行政与科研协作负责人庄晟珏" : "下一位负责人",
  },
};

const fixture = { requests: [] as { method: string; hasValidParameters: boolean }[], mutations: 0 };
Object.assign(window, { assignmentTransferFixture: fixture });
window.history.replaceState(null, "", "/email-actions/assignment-transfer/?token=fixture&candidate=next");
/** 严格模拟确认接口，遗漏参数必须失败，只有确认请求才能修改负责人。 */
window.fetch = async (input, init) => {
  const url = new URL(String(input), window.location.origin);
  const method = init?.method ?? "GET";
  const values = method === "GET" ? Object.fromEntries(url.searchParams) : JSON.parse(String(init?.body ?? "{}"));
  const valid =
    url.pathname === "/api/email-actions/assignment-transfer/" &&
    values.token === "fixture" &&
    values.candidate_id === "next" &&
    init?.credentials === "include";
  fixture.requests.push({ method, hasValidParameters: valid });
  let payload: unknown = preview;
  let status = 200;
  if (!valid) {
    status = 400;
    payload = { error_code: "assignment_transfer_invalid", message: "转派链接无效。" };
  } else if (scenario === "expired") {
    status = 410;
    payload = { error_code: "assignment_transfer_expired", message: "转派链接已过期。" };
  } else if (scenario === "login") {
    status = 401;
    payload = { detail: "Authentication credentials were not provided." };
  } else if (scenario === "changed") {
    status = 409;
    payload = {
      error_code: "assignment_changed",
      message: "负责人已变化，请到工作项详情页处理。",
      route: preview.route,
    };
  } else if (method === "POST") {
    fixture.mutations += 1;
    payload = { ...preview, status: "completed" };
  } else if (scenario === "completed") {
    payload = { ...preview, status: "already_completed" };
  }
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

createRoot(document.getElementById("root")!).render(
  <MemoryRouter initialEntries={["/email-actions/assignment-transfer/?token=fixture&candidate=next"]}>
    <AssignmentTransferConfirmation />
  </MemoryRouter>
);
