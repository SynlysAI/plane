/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

type Props = {
  /** Target route for the closest parent list or detail surface. */
  href: string;
  /** Visible label describing the destination. */
  children: ReactNode;
};

/** Render the consistent fixed navigation entry used by detail pages. */
export function DetailBackLink({ href, children }: Props) {
  return (
    <Link
      href={href}
      aria-label="返回上一级菜单"
      className="inline-flex min-h-6 max-w-full items-center gap-1 rounded px-1 text-12 font-medium text-secondary transition-colors hover:bg-surface-2 hover:text-primary"
    >
      <ChevronLeft className="size-3.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </Link>
  );
}
