/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, type ReactNode } from "react";
import { observer } from "mobx-react";
import { Navigate, useLocation, useParams, useSearchParams } from "react-router";
// plane imports
// hooks
import { useResearch } from "@/hooks/store/use-research";

type Props = {
  /** Absolute destination used only when the workspace enables IA v2. */
  to: string;
  /** Query keys added by the IA v2 destination; existing query values win. */
  query?: Record<string, string>;
  children: ReactNode;
};

/**
 * Keeps a legacy research route intact when IA v2 is off and replaces it with
 * the corresponding four-entry destination when the switch is on.
 */
export const ResearchIaV2Redirect = observer(function ResearchIaV2Redirect({ to, query, children }: Props) {
  const research = useResearch();
  const { workspaceSlug } = useParams();
  const [searchParams] = useSearchParams();
  const { hash } = useLocation();

  useEffect(() => {
    if (!workspaceSlug || research.identityWorkspaceSlug === workspaceSlug) return;
    void research.fetchIdentity(workspaceSlug).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug]);

  if (!research.isIaV2Enabled) return <>{children}</>;

  const destinationSearch = new URLSearchParams(searchParams);
  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (!destinationSearch.has(key)) destinationSearch.set(key, value);
  });
  const search = destinationSearch.toString();
  return <Navigate replace to={`${to}${search ? `?${search}` : ""}${hash}`} />;
});
