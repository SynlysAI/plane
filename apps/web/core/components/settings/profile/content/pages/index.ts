/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { lazy } from "react";
// plane imports
import type { TProfileSettingsTabs } from "@plane/types";

export const PROFILE_SETTINGS_PAGES_MAP: Record<
  TProfileSettingsTabs,
  React.LazyExoticComponent<React.FC<{ inModal?: boolean }>>
> = {
  general: lazy(() => import("./general").then((m) => ({ default: m.GeneralProfileSettings }))),
  preferences: lazy(() => import("./preferences").then((m) => ({ default: m.PreferencesProfileSettings }))),
  notifications: lazy(() => import("./notifications").then((m) => ({ default: m.NotificationsProfileSettings }))),
  security: lazy(() => import("./security").then((m) => ({ default: m.SecurityProfileSettings }))),
  "api-tokens": lazy(() => import("./api-tokens").then((m) => ({ default: m.APITokensProfileSettings }))),
  mcp: lazy(() => import("./mcp").then((m) => ({ default: m.MCPProfileSettings }))),
  "agent-configuration": lazy(() =>
    import("./agent-configuration").then((m) => ({ default: m.AgentConfigurationProfileSettings }))
  ),
};
