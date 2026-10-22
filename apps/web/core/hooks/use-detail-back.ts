/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback } from "react";
import { useNavigate } from "react-router";

/**
 * 详情页统一返回：存在可返回历史时沿用浏览器后退，直接打开（无历史）时回退到明确列表页。
 *
 * Args:
 *   fallbackHref: 无可返回历史时的目标路由。
 * Returns:
 *   返回处理函数。
 */
export const useDetailBack = (fallbackHref: string): (() => void) => {
  const navigate = useNavigate();
  return useCallback(() => {
    const state = window.history.state as { idx?: number } | null;
    if (typeof state?.idx === "number" && state.idx > 0) {
      navigate(-1);
    } else {
      navigate(fallbackHref);
    }
  }, [fallbackHref, navigate]);
};
