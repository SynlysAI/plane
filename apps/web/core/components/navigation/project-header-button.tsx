/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TPartialProject } from "@plane/types";
// plane propel imports
import { Logo } from "@plane/propel/emoji-icon-picker";
import { ChevronDownOutline } from "@makeplane/propel/icons";
import { Tooltip } from "@makeplane/propel/components/tooltip";

type TProjectHeaderButtonProps = {
  project: TPartialProject;
};

export function ProjectHeaderButton({ project }: TProjectHeaderButtonProps) {
  return (
    <Tooltip label={project.name} layout="stacked" side="bottom">
      <div className="flex w-full max-w-48 items-center gap-2 pr-1 text-left select-none">
        <div className="flex size-7 flex-shrink-0 items-center justify-center rounded-md bg-layer-1">
          <Logo logo={project.logo_props} size={16} />
        </div>
        <p className="min-w-0 flex-1 truncate text-14 font-medium text-secondary">{project.name}</p>
        <ChevronDownOutline className="size-4 shrink-0 text-tertiary" aria-hidden="true" />
      </div>
    </Tooltip>
  );
}
