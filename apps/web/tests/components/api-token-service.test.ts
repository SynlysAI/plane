/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { beforeEach, it, expect, vi } from "vitest";
const calls = vi.hoisted(() => ({ get: vi.fn(), delete: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("../../../../packages/services/src/api.service", () => ({
  APIService: class {
    get = calls.get;
    delete = calls.delete;
    post = calls.post;
    patch = calls.patch;
  },
}));
import { APITokenService } from "../../../../packages/services/src/developer/api-token.service";
beforeEach(() => {
  vi.clearAllMocks();
  calls.get.mockResolvedValue({ data: { id: "safe", token: "should-not-return" } });
  calls.delete.mockResolvedValue({ data: undefined });
});
it("matches detail/delete routes including trailing slash and strips keys from reads", async () => {
  const service = new APITokenService();
  expect(await service.retrieve("owned")).toEqual({ id: "safe" });
  expect(calls.get).toHaveBeenLastCalledWith("/api/users/api-tokens/owned/");
  await service.destroy("owned");
  expect(calls.delete).toHaveBeenLastCalledWith("/api/users/api-tokens/owned/");
  calls.get.mockResolvedValue({ data: [{ id: "safe", token: "must-not-cache" }] });
  expect(await service.list()).toEqual([{ id: "safe" }]);
});
it("preserves HTTP status even when an offline response has no data", async () => {
  calls.get.mockRejectedValue({ response: { status: 403, data: { detail: "Denied" } } });
  await expect(new APITokenService().list()).rejects.toEqual({ status: 403, detail: "Denied" });
  calls.get.mockRejectedValue(new Error("Network failure"));
  await expect(new APITokenService().list()).rejects.toEqual({ status: undefined });
});
it("preserves masked key metadata and renames without returning or submitting a full key", async () => {
  const metadata = { id: "safe", label: "Renamed", masked_token: "plane_api_abcd********1234" };
  calls.get.mockResolvedValue({ data: [{ ...metadata, token: "must-not-cache" }] });
  calls.patch.mockResolvedValue({ data: { ...metadata, token: "must-not-cache" } });
  const service = new APITokenService();
  expect(await service.list()).toEqual([metadata]);
  expect(await service.rename("safe", "Renamed")).toEqual(metadata);
  expect(calls.patch).toHaveBeenCalledExactlyOnceWith("/api/users/api-tokens/safe/", { label: "Renamed" });
});
