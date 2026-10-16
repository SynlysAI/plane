/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// plane web components
import { observer } from "mobx-react";
import { useEffect } from "react";
// hooks
import { useAnalytics } from "@/hooks/store/use-analytics";
import { useProject } from "@/hooks/store/use-project";
// components
import { ProjectSelect } from "./select/project";

const AnalyticsFilterActions = observer(function AnalyticsFilterActions() {
  const { selectedProjects, updateSelectedProjects } = useAnalytics();
  const { administrativeJoinedProjectIds: joinedProjectIds, fetchStatus } = useProject();
  const selectedKey = selectedProjects.join(",");
  const projectKey = joinedProjectIds.join(",");
  useEffect(() => {
    if (fetchStatus !== "complete") return;
    const valid = selectedProjects.filter((id) => joinedProjectIds.includes(id));
    if (valid.length !== selectedProjects.length) updateSelectedProjects(valid);
  }, [selectedKey, projectKey, selectedProjects, joinedProjectIds, fetchStatus, updateSelectedProjects]);
  return (
    <div className="flex items-center justify-end gap-2">
      <ProjectSelect
        value={selectedProjects}
        onChange={(val) => {
          updateSelectedProjects(val ?? []);
        }}
        projectIds={joinedProjectIds}
      />
      {/* <DurationDropdown
        buttonVariant="border-with-text"
        value={selectedDuration}
        onChange={(val) => {
          updateSelectedDuration(val);
        }}
        dropdownArrow
      /> */}
    </div>
  );
});

export default AnalyticsFilterActions;
