/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { projectIdentifierSanitizer } from "@plane/utils";

export const generateProjectIdentifierFallback = (): string =>
  `PRJ${Math.floor(Math.random() * 36 ** 7)
    .toString(36)
    .padStart(7, "0")
    .toUpperCase()}`;

export const projectIdentifierFromName = (name: string, fallback: string): string => {
  if (!name.trim()) return "";
  const identifier = projectIdentifierSanitizer(name).substring(0, 10);
  return identifier.length >= 3 ? identifier : fallback;
};
