/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";

/** Evaluate time only after mount and update when a long-lived page crosses expiry. */
export function useExpiration(expires: string | null): boolean | null {
  const [snapshot, setSnapshot] = useState<{ expires: string; expired: boolean } | null>(null);
  useEffect(() => {
    if (!expires) return;
    const deadline = Date.parse(expires);
    if (!Number.isFinite(deadline)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function update() {
      const remaining = deadline - Date.now();
      setSnapshot({ expires: expires!, expired: remaining <= 0 });
      // Browsers clamp larger delays to 1 ms; schedule long-lived credentials in chunks.
      if (remaining > 0) timer = setTimeout(update, Math.min(remaining, 2_147_483_647));
    }
    update();
    return () => clearTimeout(timer);
  }, [expires]);
  return snapshot?.expires === expires ? snapshot.expired : null;
}
