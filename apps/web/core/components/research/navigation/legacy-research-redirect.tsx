/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect } from "react";
import { observer } from "mobx-react";
import { Navigate, useLocation, useParams, useSearchParams } from "react-router";
// hooks
import { useResearch } from "@/hooks/store/use-research";

type Props = {
  /** Absolute destination of the consolidated route. */
  to: string;
  /** Query keys added by the destination; existing query values win. */
  query?: Record<string, string>;
};

/**
 * Legacy research list routes have been consolidated into their new destinations.
 * This redirect always forwards while preserving caller query values and hash.
 */
export const LegacyResearchRedirect = observer(function LegacyResearchRedirect({ to, query }: Props) {
  const research = useResearch();
  const { workspaceSlug } = useParams();
  const [searchParams] = useSearchParams();
  const { hash } = useLocation();

  useEffect(() => {
    if (!workspaceSlug || research.identityWorkspaceSlug === workspaceSlug) return;
    void research.fetchIdentity(workspaceSlug).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug]);

  const destinationSearch = new URLSearchParams(searchParams);
  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (!destinationSearch.has(key)) destinationSearch.set(key, value);
  });
  const search = destinationSearch.toString();
  return <Navigate replace to={`${to}${search ? `?${search}` : ""}${hash}`} />;
});
