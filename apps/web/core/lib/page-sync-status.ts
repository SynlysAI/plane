/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export type TPageSyncStatus = "syncing" | "synced" | "error";

export type TPageSyncDecision = {
  latchedOffline: boolean;
  syncStatus: TPageSyncStatus;
  reportDisconnected: boolean;
};

/**
 * 把协作阶段收成页面上的同步状态。失败后保持离线，不再回到同步中。
 */
export function nextPageSyncStatus(latchedOffline: boolean, stageKind: string): TPageSyncDecision {
  if (stageKind === "synced") {
    return { latchedOffline: false, syncStatus: "synced", reportDisconnected: false };
  }
  if (stageKind === "disconnected" || stageKind === "reconnecting" || latchedOffline) {
    return { latchedOffline: true, syncStatus: "error", reportDisconnected: true };
  }
  return { latchedOffline: false, syncStatus: "syncing", reportDisconnected: false };
}
