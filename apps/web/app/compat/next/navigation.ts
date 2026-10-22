/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo, useRef } from "react";
import { useLocation, useNavigate, useParams as useParamsRR, useSearchParams as useSearchParamsRR } from "react-router";
import { ensureTrailingSlash } from "./helper";

export function useRouter() {
  const navigate = useNavigate();
  // 单调递增令牌：连续点击时仅执行最后一次导航，避免更早的延迟导航覆盖最新意图。
  const navigationTokenRef = useRef(0);
  return useMemo(
    () => ({
      push: (to: string) => {
        deferNavigation(navigationTokenRef, () => navigate(ensureTrailingSlash(to)));
      },
      replace: (to: string) => {
        deferNavigation(navigationTokenRef, () => navigate(ensureTrailingSlash(to), { replace: true }));
      },
      back: () => {
        deferNavigation(navigationTokenRef, () => navigate(-1));
      },
      forward: () => {
        deferNavigation(navigationTokenRef, () => navigate(1));
      },
      refresh: () => {
        location.reload();
      },
      prefetch: async (_to: string) => {
        // no-op in this shim
      },
    }),
    [navigate]
  );
}

/**
 * 延迟执行导航并携带令牌校验，执行前若已有更新的导航意图则放弃当前导航。
 *
 * Args:
 *   tokenRef: 导航令牌引用。
 *   run: 实际导航动作。
 */
function deferNavigation(tokenRef: React.RefObject<number>, run: () => void): void {
  tokenRef.current += 1;
  const token = tokenRef.current;
  // Defer navigation to avoid state updates during render
  setTimeout(() => {
    if (tokenRef.current !== token) return;
    run();
  }, 0);
}

export function usePathname(): string {
  const { pathname } = useLocation();
  return pathname;
}

export function useSearchParams(): URLSearchParams {
  const [searchParams] = useSearchParamsRR();
  return searchParams;
}

export function useParams() {
  return useParamsRR();
}
