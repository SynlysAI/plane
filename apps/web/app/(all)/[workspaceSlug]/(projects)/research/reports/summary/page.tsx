/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "react-router";
// components
import { LegacyResearchRedirect } from "@/components/research/navigation/legacy-research-redirect";

function WorkspaceResearchSummaryPage() {
  const { workspaceSlug } = useParams();
  if (!workspaceSlug) return null;
  return <LegacyResearchRedirect to={`/${workspaceSlug}/research`} query={{ view: "report_submission" }} />;
}

export default observer(WorkspaceResearchSummaryPage);
