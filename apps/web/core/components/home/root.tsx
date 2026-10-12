/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "next/navigation";
// plane imports
import { ContentWrapper } from "@plane/ui";
import { useUserProfile } from "@/hooks/store/user";
// plane web imports
import { TourRoot } from "@/components/onboarding/tour/root";
// local imports
import { WorkspaceHomeWorkbench } from "./workbench";

export const WorkspaceHomeView = observer(function WorkspaceHomeView() {
  // store hooks
  const { workspaceSlug } = useParams();
  const { data: currentUserProfile, updateTourCompleted } = useUserProfile();
  const handleTourCompleted = async () => {
    try {
      await updateTourCompleted();
    } catch (error) {
      console.error("Error updating tour completed", error);
    }
  };

  // TODO: refactor loader implementation
  return (
    <>
      {currentUserProfile && !currentUserProfile.is_tour_completed && (
        <div className="fixed top-0 left-0 z-20 grid h-full w-full place-items-center overflow-y-auto bg-backdrop transition-opacity">
          <TourRoot onComplete={handleTourCompleted} />
        </div>
      )}
      <>
        <ContentWrapper className="mx-auto scrollbar-hide h-full min-h-0 gap-6 bg-canvas px-page-x">
          {workspaceSlug && <WorkspaceHomeWorkbench workspaceSlug={workspaceSlug.toString()} />}
        </ContentWrapper>
      </>
    </>
  );
});
