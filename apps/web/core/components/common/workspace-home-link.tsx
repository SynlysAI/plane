/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { HomeOutline } from "@makeplane/propel/icons";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";

type Props = {
  /** Explicit workspace slug for surfaces outside a workspace route. */
  workspaceSlug?: string;
  /** Optional label used by profile settings to say “Back to workspace”. */
  label?: string;
  className?: string;
};

/**
 * Render the quiet, shared link back to the current workspace home.
 *
 * Args:
 *   workspaceSlug: Explicit workspace slug, or undefined to use the route parameter.
 *   label: Optional visible label; defaults to “Back to home”.
 *   className: Additional class names merged into the quiet link style.
 * Returns:
 *   The workspace home link, or null when no workspace slug is available.
 */
export function WorkspaceHomeLink({ workspaceSlug, label, className }: Props) {
  const { t } = useTranslation();
  const routeParams = useParams();
  const slug = workspaceSlug ?? routeParams.workspaceSlug?.toString();
  const visibleLabel = label ?? t("back_to_home");

  if (!slug) return null;

  return (
    <Link
      href={`/${slug}`}
      aria-label={visibleLabel}
      className={cn(
        "inline-flex min-h-6 items-center gap-1.5 rounded px-1 text-12 font-medium text-secondary transition-colors hover:bg-surface-2 hover:text-primary",
        className
      )}
    >
      <HomeOutline className="size-3.5 shrink-0" aria-hidden="true" />
      <span>{visibleLabel}</span>
    </Link>
  );
}
