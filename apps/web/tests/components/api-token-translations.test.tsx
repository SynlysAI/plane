/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { initPromise, setLanguage, TranslationProvider, useTranslation } from "@plane/i18n";

const keys = [
  "account_settings.api_tokens.title",
  "api_token_management.list_description",
  "api_token_management.rename",
  "api_token_management.actions",
  "api_token_management.created_date",
  "api_token_management.last_used_date",
  "workspace_settings.settings.api_tokens.add_token",
  "workspace_settings.copy_key",
  "delete",
];
function Labels() {
  const { t } = useTranslation();
  return <span>{keys.map((key) => t(key)).join(" | ")}</span>;
}

it.each(["zh-CN", "en"] as const)("loads actual bundled API-token translations in %s", async (language) => {
  await initPromise;
  await setLanguage(language);
  const markup = renderToStaticMarkup(
    <TranslationProvider>
      <Labels />
    </TranslationProvider>
  );
  for (const key of keys) expect(markup).not.toContain(key);
  expect(markup).toContain(language === "zh-CN" ? "修改名称" : "Rename");
  expect(markup).not.toContain("CSV");
});
