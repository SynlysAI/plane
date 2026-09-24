/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { TabNavigationItem } from "@plane/propel/tab-navigation";

type TResearchTabLinkProps = {
  /** 路由链接。 */
  href: string;
  /** 是否当前激活；保持 URL 与 aria-current 同源。 */
  isActive: boolean;
  children: ReactNode;
};

/** 科研统一标签链接：TabNavigationItem 的路由包装，保留 aria-current 语义。 */
export function ResearchTabLink({ href, isActive, children }: TResearchTabLinkProps) {
  return (
    <Link href={href} aria-current={isActive ? "page" : undefined} className="whitespace-nowrap">
      <TabNavigationItem isActive={isActive}>{children}</TabNavigationItem>
    </Link>
  );
}
