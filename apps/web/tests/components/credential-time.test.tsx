// @vitest-environment jsdom
/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalDate } from "@/components/core/local-date";
import { useExpiration } from "@/hooks/use-expiration";

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
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
  vi.useRealTimers();
});
const timestamp = "2026-10-22T00:00:00Z";

it("hydrates a stable server placeholder before showing the viewer's local date", async () => {
  const format = vi.spyOn(Date.prototype, "toLocaleString").mockReturnValue("CLIENT LOCAL TIME");
  const element = <LocalDate value={timestamp} />;
  container.innerHTML = renderToString(element);
  expect(format).not.toHaveBeenCalled();
  expect(container.textContent).toBe("—");
  const recoverable = vi.fn();
  await act(async () => {
    root = hydrateRoot(container, element, { onRecoverableError: recoverable });
  });
  expect(recoverable).not.toHaveBeenCalled();
  expect(container.textContent).toBe("CLIENT LOCAL TIME");
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe(timestamp);
});

it.each([null, "invalid"])("clears a previous local date for %s", async (value) => {
  root = createRoot(container);
  await act(async () => root!.render(<LocalDate value={timestamp} dateOnly />));
  expect(container.querySelector("time")).not.toBeNull();
  await act(async () => root!.render(<LocalDate value={value} emptyLabel="No date" />));
  expect(container.querySelector("time")).toBeNull();
  expect(container.textContent).toBe("No date");
});

function Status({ expires }: { expires: string | null }) {
  const expired = useExpiration(expires);
  return <span>{expired === null ? "pending" : expired ? "expired" : "active"}</span>;
}

it("updates expiry at the deadline and cancels the timer on unmount", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(timestamp));
  root = createRoot(container);
  await act(async () => root!.render(<Status expires="2026-10-22T00:00:01Z" />));
  expect(container.textContent).toBe("active");
  await act(async () => vi.advanceTimersByTime(1000));
  expect(container.textContent).toBe("expired");
  await act(async () => root!.render(<Status expires="2027-10-22T00:00:00Z" />));
  expect(container.textContent).toBe("active");
  await act(async () => vi.advanceTimersByTime(1000));
  expect(container.textContent).toBe("active");
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => root!.unmount());
  root = undefined;
  expect(vi.getTimerCount()).toBe(0);
});
