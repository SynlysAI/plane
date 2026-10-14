/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { DIRECT_INTEGRATION_SYSTEMS, INTEGRATION_SYSTEM_LABELS } from "@plane/constants";
import type { TIntegrationConnection } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { ListFilterField, ListFilterInput, ListFilterSelect, ListFilterCheckbox } from "@plane/ui";
// components
import { getResearchErrorKey } from "@/components/research/common/error-messages";
import { ResearchFilterToolbar } from "@/components/research/common/research-data-surface";

type Props = {
  connections: TIntegrationConnection[];
  onSave: (items: Array<Record<string, unknown>>) => Promise<void>;
};

/** Connection editor: the token is written directly and never echoed back (P1-INT-01/02). */
export const IntegrationConnectionForm = observer(function IntegrationConnectionForm({ connections, onSave }: Props) {
  const { t } = useTranslation();
  const [system, setSystem] = useState<string>("RAGPORTAL");
  const [displayName, setDisplayName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [credentialMode, setCredentialMode] = useState<"SHARED" | "PERSONAL">("SHARED");
  const [credential, setCredential] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const existing = connections.find((connection) => connection.system === system);

  return (
    <div className="flex flex-col gap-2">
      <ResearchFilterToolbar>
        <ListFilterField label={t("research.integrations.columns.system")} className="w-full sm:w-48">
          <ListFilterSelect
            value={system}
            onChange={(event) => {
              setSystem(event.target.value);
              const next = connections.find((connection) => connection.system === event.target.value);
              setDisplayName(next?.display_name ?? "");
              setBaseUrl(next?.base_url ?? "");
              setCredentialMode(next?.credential_mode ?? "SHARED");
              setCredential("");
              setEnabled(Boolean(next?.is_enabled));
            }}
          >
            {DIRECT_INTEGRATION_SYSTEMS.map((value) => (
              <option key={value} value={value}>
                {t(INTEGRATION_SYSTEM_LABELS[value])}
              </option>
            ))}
          </ListFilterSelect>
        </ListFilterField>
        <ListFilterField label={t("research.integrations.display_name")} className="w-full sm:w-40">
          <ListFilterInput
            value={displayName}
            placeholder={t("research.integrations.display_name")}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </ListFilterField>
        <ListFilterField label="服务地址" className="w-full sm:w-64">
          <ListFilterInput
            value={baseUrl}
            placeholder={baseUrl ? "" : t("research.integrations.base_url_hint")}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </ListFilterField>
        <ListFilterField label="凭证模式" className="w-full sm:w-40">
          <ListFilterSelect
            value={credentialMode}
            onChange={(event) => {
              setCredentialMode(event.target.value as "SHARED" | "PERSONAL");
              setCredential("");
            }}
          >
            <option value="SHARED">公共凭证</option>
            <option value="PERSONAL">个人凭证</option>
          </ListFilterSelect>
        </ListFilterField>
        {credentialMode === "SHARED" && (
          <ListFilterField label="访问 Token" className="w-full sm:w-64">
            <ListFilterInput
              type="password"
              value={credential}
              placeholder={existing?.has_credential ? "已配置，留空保持不变" : "直接填写服务访问 Token"}
              onChange={(event) => setCredential(event.target.value)}
              autoComplete="off"
            />
          </ListFilterField>
        )}
        <ListFilterCheckbox
          label={t("research.integrations.enabled")}
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        <Button
          size="xl"
          variant="primary"
          disabled={!baseUrl.trim()}
          onClick={async () => {
            try {
              await onSave([
                {
                  system,
                  display_name: displayName || system,
                  base_url: baseUrl.trim(),
                  credential_mode: credentialMode,
                  ...(credentialMode === "SHARED" && credential.trim() ? { credential: credential.trim() } : {}),
                  is_enabled: enabled,
                },
              ]);
              setCredential("");
              setErrorKey(null);
            } catch (error) {
              setErrorKey(getResearchErrorKey(error));
            }
          }}
        >
          {t("research.common.save")}
        </Button>
      </ResearchFilterToolbar>
      {errorKey && <p className="text-12 text-danger-primary">{t(errorKey)}</p>}
      <p className="text-11 text-tertiary">
        {credentialMode === "PERSONAL"
          ? "个人凭证模式：每位成员在个人设置里配置自己的 Token，公共连接不再保存密钥。"
          : existing?.has_credential
            ? t("research.integrations.credential_configured")
            : t("research.integrations.credential_hint")}
      </p>
    </div>
  );
});
