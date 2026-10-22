/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
import { DetailBackLink } from "@/components/common/detail-back-link";

type Props = {
  /** Target route of the closest upper-level object list. */
  href: string;
  /** Link text describing the upper-level surface. */
  children: ReactNode;
};

/** Render the single, quiet navigation entry used by research detail pages. */
export function ResearchBackLink({ href, children }: Props) {
  return <DetailBackLink href={href}>{children}</DetailBackLink>;
}
