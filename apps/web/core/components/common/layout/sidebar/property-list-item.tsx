/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
import { cn } from "@plane/utils";

type TSidebarPropertyListItemProps = {
  icon: React.FC<{ className?: string }>;
  label: string;
  children: ReactNode;
  appendElement?: ReactNode;
  childrenClassName?: string;
};

export function SidebarPropertyListItem(props: TSidebarPropertyListItemProps) {
  const { icon: Icon, label, children, appendElement, childrenClassName } = props;

  return (
    <div data-sidebar-property-list-item className="flex min-w-0 items-start gap-2 @max-md:flex-col @max-md:gap-1">
      <div
        data-sidebar-property-label
        className="flex min-h-7.5 w-30 shrink-0 items-center gap-1.5 text-body-xs-regular text-tertiary @max-md:w-full"
      >
        <Icon className="size-4 shrink-0" />
        <span className="min-w-0 break-words">{label}</span>
        {appendElement}
      </div>
      <div
        data-sidebar-property-value
        className={cn("flex min-w-0 grow flex-wrap items-center gap-1 @max-md:w-full", childrenClassName)}
      >
        {children}
      </div>
    </div>
  );
}
