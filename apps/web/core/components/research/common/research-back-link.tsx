/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

type Props = {
  /** Target route of the closest upper-level object list. */
  href: string;
  /** Link text describing the upper-level surface. */
  children: ReactNode;
};

/** Render the single, quiet navigation entry used by research detail pages. */
export function ResearchBackLink({ href, children }: Props) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-6 items-center gap-1 rounded text-12 font-medium text-secondary transition-colors hover:text-primary"
    >
      <ChevronLeft className="size-3.5" aria-hidden="true" />
      <span>{children}</span>
    </Link>
  );
}
