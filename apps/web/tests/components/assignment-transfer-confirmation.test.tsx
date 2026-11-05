// @vitest-environment jsdom
/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AssignmentTransferConfirmation } from "@/components/email-actions/assignment-transfer-confirmation";

vi.mock("@plane/constants", () => ({ API_BASE_URL: "https://plane.test" }));

const preview = {
  status: "ready",
  entity_type: "research_work_item",
  title: "JACS 审稿意见回复",
  workspace_slug: "lab",
  route: "/lab/research/chains/chain-1?node=node-1&task=task-1",
  expires_at: "2026-11-12T03:00:00.000Z",
  current_assignee: { id: "owner", display_name: "当前负责人" },
  candidate: { id: "next", display_name: "下一位负责人" },
};

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
});

async function renderComponent(path: string) {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <AssignmentTransferConfirmation />
      </MemoryRouter>
    );
  });
}

function responseBody(value: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}

function linkByText(text: string) {
  return Array.from(container.querySelectorAll("a")).find((item) => item.textContent?.includes(text));
}

it("previews, confirms, and shows the completed transfer without leaving the page", async () => {
  const fetchMock = vi.fn(async (input: string, options: RequestInit) => {
    const url = new URL(input);
    if (options.method === "GET") {
      if (url.searchParams.get("token") !== "signed" || url.searchParams.get("candidate_id") !== "next") {
        return responseBody({ error_code: "assignment_transfer_invalid", message: "转派链接无效。" }, 400);
      }
      return responseBody(preview);
    }
    return responseBody({ ...preview, status: "completed" });
  });
  vi.stubGlobal("fetch", fetchMock);
  await renderComponent("/email-actions/assignment-transfer/?token=signed&candidate=next");

  expect(container.textContent).toContain("JACS 审稿意见回复");
  expect(container.textContent).toContain("下一位负责人");
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
    "https://plane.test/api/email-actions/assignment-transfer/?token=signed&candidate_id=next",
    { method: "GET", credentials: "include", headers: { Accept: "application/json" } }
  );
  expect(container.textContent).not.toContain("转派完成");

  await act(async () => {
    container.querySelector<HTMLButtonElement>("button[type='button']")!.click();
  });

  expect(container.textContent).toContain("转派完成");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1][1]).toMatchObject({
    method: "POST",
    credentials: "include",
    body: JSON.stringify({ token: "signed", candidate_id: "next" }),
  });
  expect(fetchMock.mock.calls[1][0]).toBe("https://plane.test/api/email-actions/assignment-transfer/");
});

it("encodes query values without losing token punctuation", async () => {
  const token = "signed:token+with/&=中文";
  const candidate = "next&member";
  const fetchMock = vi.fn().mockResolvedValue(responseBody(preview));
  vi.stubGlobal("fetch", fetchMock);
  await renderComponent(`/email-actions/assignment-transfer/?${new URLSearchParams({ token, candidate })}`);

  const url = new URL(fetchMock.mock.calls[0][0]);
  expect(url.searchParams.get("token")).toBe(token);
  expect(url.searchParams.get("candidate_id")).toBe(candidate);
  expect([...url.searchParams.keys()]).toEqual(["token", "candidate_id"]);
});

it.each(["", "?token=signed", "?candidate=next"])(
  "rejects missing parameters without requesting the API: %s",
  async (query) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await renderComponent(`/email-actions/assignment-transfer/${query}`);

    expect(container.textContent).toContain("转派链接无效");
    expect(fetchMock).not.toHaveBeenCalled();
  }
);

it("shows an already completed transfer without offering another submission", async () => {
  const fetchMock = vi.fn().mockResolvedValue(responseBody({ ...preview, status: "already_completed" }));
  vi.stubGlobal("fetch", fetchMock);
  await renderComponent("/email-actions/assignment-transfer/?token=signed&candidate=next");

  expect(container.textContent).toContain("无需重复操作");
  expect(container.querySelector("button")).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it.each([
  ["assignment_transfer_expired", "转派链接已过期。", 410],
  ["assignment_transfer_invalid", "转派链接无效。", 400],
])("shows the server rejection without offering confirmation: %s", async (error_code, message, status) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseBody({ error_code, message }, status)));
  await renderComponent("/email-actions/assignment-transfer/?token=signed&candidate=next");

  expect(container.textContent).toContain(message);
  expect(container.querySelector("button")).toBeNull();
});

it("preserves the full confirmation URL when guiding an unauthenticated recipient to sign in", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(responseBody({ error_code: "authentication_required", message: "请先登录。" }, 401));
  vi.stubGlobal("fetch", fetchMock);
  const path = "/email-actions/assignment-transfer/?token=signed&candidate=next";
  await renderComponent(path);

  expect(container.textContent).toContain("该操作需要邮件接收人本人登录");
  const login = linkByText("去登录");
  expect(login?.getAttribute("href")).toBe(`/?next_path=${encodeURIComponent(path)}`);
});

it("treats a DRF unauthenticated 403 response as a sign-in prompt", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(responseBody({ detail: "Authentication credentials were not provided." }, 403));
  vi.stubGlobal("fetch", fetchMock);
  await renderComponent("/email-actions/assignment-transfer/?token=signed&candidate=next");

  expect(container.textContent).toContain("该操作需要邮件接收人本人登录");
  expect(linkByText("去登录")).not.toBeUndefined();
});

it("offers the native work-item route when the owner or candidate has changed", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    responseBody(
      {
        error_code: "assignment_changed",
        message: "负责人已变化，请到工作项详情页处理。",
        route: preview.route,
      },
      409
    )
  );
  vi.stubGlobal("fetch", fetchMock);
  await renderComponent("/email-actions/assignment-transfer/?token=signed&candidate=next");

  const native = linkByText("打开原生网页");
  expect(native?.getAttribute("href")).toBe(`http://localhost:3000${preview.route}`);
});
