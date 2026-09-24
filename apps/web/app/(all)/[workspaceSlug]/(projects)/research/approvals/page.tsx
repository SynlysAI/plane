/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "react-router";
// components
import { ResearchApprovalCenter } from "@/components/research/approvals/research-approval-center";

function WorkspaceResearchApprovalsPage() {
  const { workspaceSlug } = useParams();
  if (!workspaceSlug) return null;

  return <ResearchApprovalCenter workspaceSlug={workspaceSlug} />;
}

export default observer(WorkspaceResearchApprovalsPage);
