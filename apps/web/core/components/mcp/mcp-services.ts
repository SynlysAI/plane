/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import {
  NativeMCPService,
  ResearchMCPService,
  type TNativeCandidates,
  type TNativeOptions,
  type TNativeSession,
  type TNativeToken,
} from "@/services/mcp.service";
import { failureMessage } from "./connection-config";

export const nativeService = new NativeMCPService();
export const researchService = new ResearchMCPService();
export type NativeState = {
  options: TNativeOptions | null;
  session: TNativeSession | null;
  candidates: TNativeCandidates | null;
  tokens: TNativeToken[];
};
export const emptyNative: NativeState = { options: null, session: null, candidates: null, tokens: [] };

export async function loadNativeState(): Promise<{ state: NativeState; message: string }> {
  const options = await nativeService.read<TNativeOptions>("options");
  let session: TNativeSession | null = null;
  try {
    session = await nativeService.read<TNativeSession>("session");
  } catch (error) {
    if ((error as { status?: number }).status !== 401) throw error;
  }
  if (!session) return { state: { ...emptyNative, options }, message: "" };
  const { tokens } = await nativeService.read<{ tokens: TNativeToken[] }>("tokens");
  try {
    const candidates = await nativeService.read<TNativeCandidates>("candidates");
    return { state: { options, session, candidates, tokens }, message: "" };
  } catch (error) {
    if ((error as { status?: number }).status === 401) session = null;
    return {
      state: { options, session, candidates: null, tokens },
      message: failureMessage(error) + " 行政候选暂不可用，已有连接仍可管理。若门户版本较旧，请更新接入服务。",
    };
  }
}
