/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useSyncExternalStore } from "react";
import { format } from "date-fns";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/** Keep the server and hydration snapshot stable, then use the viewer's timezone. */
export function LocalDate({
  value,
  dateOnly = false,
  emptyLabel = "—",
}: {
  value: string | null;
  dateOnly?: boolean;
  emptyLabel?: string;
}) {
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  if (!mounted || !value) return <span>{emptyLabel}</span>;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return <span>{emptyLabel}</span>;
  const { locale, timeZone } = Intl.DateTimeFormat().resolvedOptions();
  const title = date.toLocaleString(locale, { timeZone });
  return (
    <time dateTime={value} title={title}>
      {dateOnly ? format(date, "yyyy-MM-dd") : title}
    </time>
  );
}
