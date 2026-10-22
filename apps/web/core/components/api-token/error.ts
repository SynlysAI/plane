/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export function tokenErrorKey(error: { status?: number; detail?: string } | undefined) {
  if (
    error?.status === 401 ||
    (error?.status === 403 && /authentication credentials|not authenticated/i.test(error.detail ?? ""))
  )
    return "api_token_management.login_expired";
  return error?.status === 403 ? "api_token_management.forbidden" : "api_token_management.load_error";
}
