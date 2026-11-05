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
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(responseBody(preview))
    .mockResolvedValueOnce(responseBody({ ...preview, status: "completed" }));
  vi.stubGlobal("fetch", fetchMock);
  await renderComponent("/email-actions/assignment-transfer/?token=signed&candidate=next");

  expect(container.textContent).toContain("JACS 审稿意见回复");
  expect(container.textContent).toContain("下一位负责人");
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://plane.test/api/email-actions/assignment-transfer/", {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });

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
