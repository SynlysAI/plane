/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Navigate, useParams } from "react-router";

/** Compatibility redirect from the legacy research overview to Workspace Home. */
export default function WorkspaceResearchOverviewPage() {
  const { workspaceSlug } = useParams();
  if (!workspaceSlug) return null;
  return <Navigate replace to={`/${workspaceSlug}`} />;
}
