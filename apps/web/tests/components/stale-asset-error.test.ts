// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const reloadKey = "__plane_chunk_reload";
const pendingNavKey = "__plane_pending_nav";
const assignMock = vi.fn();
const reloadMock = vi.fn();
const originalLocation = window.location;

/** 重新加载模块以复位内部恢复状态。 */
const loadModule = async () => {
  vi.resetModules();
  return await import("@/lib/stale-asset-error");
};

beforeEach(() => {
  sessionStorage.clear();
  assignMock.mockClear();
  reloadMock.mockClear();
  // jsdom 的 location 方法不可单独 spy，用可 mock 的对象整体替换。
  delete (window as { location?: Location }).location;
  window.location = {
    href: originalLocation.href,
    origin: originalLocation.origin,
    assign: assignMock,
    reload: reloadMock,
  } as Location;
});

afterEach(() => {
  delete (window as { location?: Location }).location;
  window.location = originalLocation;
  sessionStorage.clear();
});

it("opens the pending navigation target instead of reloading the current page", async () => {
  sessionStorage.setItem(
    pendingNavKey,
    JSON.stringify({ target: "/lab/projects/project-id/issues/", recordedAt: Date.now() })
  );
  const { recoverFromStaleAsset } = await loadModule();

  expect(recoverFromStaleAsset()).toBe(true);
  expect(assignMock).toHaveBeenCalledWith(`${window.location.origin}/lab/projects/project-id/issues/`);
  expect(reloadMock).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(pendingNavKey)).toBeNull();
});

it("reloads in place when no pending navigation was recorded", async () => {
  const { recoverFromStaleAsset } = await loadModule();

  expect(recoverFromStaleAsset()).toBe(true);
  expect(reloadMock).toHaveBeenCalled();
  expect(assignMock).not.toHaveBeenCalled();
});

it("reloads in place when the pending navigation target expired", async () => {
  sessionStorage.setItem(
    pendingNavKey,
    JSON.stringify({ target: "/lab/projects/project-id/issues/", recordedAt: Date.now() - 60_000 })
  );
  const { recoverFromStaleAsset } = await loadModule();

  expect(recoverFromStaleAsset()).toBe(true);
  expect(reloadMock).toHaveBeenCalled();
  expect(assignMock).not.toHaveBeenCalled();
});

it("reloads in place when the pending target equals the current URL", async () => {
  sessionStorage.setItem(pendingNavKey, JSON.stringify({ target: "/", recordedAt: Date.now() }));
  const { recoverFromStaleAsset } = await loadModule();

  expect(recoverFromStaleAsset()).toBe(true);
  expect(reloadMock).toHaveBeenCalled();
  expect(assignMock).not.toHaveBeenCalled();
});

it("surfaces the error instead of looping when a reload happened recently", async () => {
  sessionStorage.setItem(reloadKey, String(Date.now()));
  sessionStorage.setItem(pendingNavKey, JSON.stringify({ target: "/lab/", recordedAt: Date.now() }));
  const { recoverFromStaleAsset } = await loadModule();

  expect(recoverFromStaleAsset()).toBe(false);
  expect(assignMock).not.toHaveBeenCalled();
  expect(reloadMock).not.toHaveBeenCalled();
});
