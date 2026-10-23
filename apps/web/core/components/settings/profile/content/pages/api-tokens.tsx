/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import useSWR from "swr";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { EmptyStateCompact } from "@plane/propel/empty-state";
import { APITokenService } from "@plane/services";
// components
import { CreateApiTokenModal } from "@/components/api-token/modal/create-token-modal";
import { ApiTokenListItem } from "@/components/api-token/token-list-item";
import { tokenErrorKey } from "@/components/api-token/error";
import { ProfileSettingsHeading } from "@/components/settings/profile/heading";
import { APITokenSettingsLoader } from "@/components/ui/loader/settings/api-token";
// constants
import { API_TOKENS_LIST } from "@plane/constants";

const apiTokenService = new APITokenService();

export const APITokensProfileSettings = observer(function APITokensProfileSettings() {
  // states
  const [isCreateTokenModalOpen, setIsCreateTokenModalOpen] = useState(false);
  // store hooks
  const {
    data: tokens,
    error,
    isLoading,
    mutate,
  } = useSWR(API_TOKENS_LIST, () => apiTokenService.list(), { shouldRetryOnError: false });
  // translation
  const { t } = useTranslation();

  if (isLoading && !tokens) {
    return <APITokenSettingsLoader />;
  }

  return (
    <div className="size-full">
      <CreateApiTokenModal isOpen={isCreateTokenModalOpen} onClose={() => setIsCreateTokenModalOpen(false)} />
      <ProfileSettingsHeading
        title="Plane API"
        description={t("api_token_management.list_description")}
        control={
          <Button variant="primary" size="lg" onClick={() => setIsCreateTokenModalOpen(true)}>
            {t("workspace_settings.settings.api_tokens.add_token")}
          </Button>
        }
      />
      <div className="mt-7">
        {error && (
          <div role="alert" className="mb-4 space-y-2 text-danger-primary">
            <p>{t(tokenErrorKey(error))}</p>
            {tokenErrorKey(error) === "api_token_management.login_expired" ? (
              <a href="/">{t("api_token_management.sign_in")}</a>
            ) : (
              <Button variant="secondary" onClick={() => void mutate()}>
                {t("api_token_management.retry")}
              </Button>
            )}
          </div>
        )}
        {tokens && tokens.length > 0 ? (
          <div className="overflow-x-auto rounded-lg bg-surface-2 p-3">
            <table
              className="w-full min-w-[600px] text-left text-14"
              aria-label={t("account_settings.api_tokens.title")}
            >
              <thead className="border-b border-subtle text-secondary">
                <tr>
                  <th scope="col" className="px-3 py-3 font-medium">
                    {t("name")}
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    Key
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    {t("api_token_management.created_date")}
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    {t("api_token_management.last_used_date")}
                  </th>
                  <th scope="col" className="px-3 py-3">
                    <span className="sr-only">{t("api_token_management.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((token) => (
                  <ApiTokenListItem key={token.id} token={token} />
                ))}
              </tbody>
            </table>
          </div>
        ) : !error && tokens ? (
          <EmptyStateCompact
            assetKey="token"
            assetClassName="size-20"
            title={t("settings_empty_state.tokens.title")}
            description={t("settings_empty_state.tokens.description")}
            actions={[
              {
                label: t("settings_empty_state.tokens.cta_primary"),
                onClick: () => {
                  setIsCreateTokenModalOpen(true);
                },
              },
            ]}
            align="start"
            rootClassName="py-20"
          />
        ) : null}
      </div>
    </div>
  );
});
