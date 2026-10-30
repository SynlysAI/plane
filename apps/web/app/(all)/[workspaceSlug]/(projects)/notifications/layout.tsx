/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Outlet } from "react-router";
import { useParams } from "next/navigation";
// components
import { InboxSidebar } from "@/components/inbox";

export default function ProjectInboxIssuesLayout() {
  const { workspaceSlug } = useParams();

  return (
    <div className="relative flex h-full w-full items-center overflow-hidden">
      {workspaceSlug && <InboxSidebar workspaceSlug={workspaceSlug.toString()} />}
      <div className="h-full w-full min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}
