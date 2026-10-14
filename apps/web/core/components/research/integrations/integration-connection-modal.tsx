/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useState } from "react";
import { useTranslation } from "@plane/i18n";
import { INTEGRATION_SYSTEM_LABELS } from "@plane/constants";
import type { TIntegrationConnection, TIntegrationSystem } from "@plane/constants";
import { Button } from "@plane/propel/button";
import { ModalCore, ListFilterField, ListFilterInput, ListFilterSelect, ListFilterCheckbox } from "@plane/ui";
import { EModalWidth } from "@plane/ui";
// components
import { getResearchErrorKey } from "@/components/research/common/error-messages";
// store
import { useResearch } from "@/hooks/store/use-research";

type Props = {
  workspaceSlug: string;
  system: string;
  connection: TIntegrationConnection | undefined;
  onClose: () => void;
};

/** Per-connection editor: opened from the health board's action column. */
export const IntegrationConnectionModal = observer(function IntegrationConnectionModal({
  workspaceSlug,
  system,
  connection,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const [displayName, setDisplayName] = useState(connection?.display_name ?? system);
  const [baseUrl, setBaseUrl] = useState(connection?.base_url ?? "");
  const [credentialMode, setCredentialMode] = useState<"SHARED" | "PERSONAL">(
    connection?.credential_mode === "PERSONAL" ? "PERSONAL" : "SHARED"
  );
  const [credential, setCredential] = useState("");
  const [enabled, setEnabled] = useState(Boolean(connection?.is_enabled));
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const handleSave = async () => {
    setBusy(true);
    try {
      await research.updateIntegrations(workspaceSlug, [
        {
          system,
          display_name: displayName || system,
          base_url: baseUrl.trim(),
          credential_mode: credentialMode,
          ...(credentialMode === "SHARED" && credential.trim() ? { credential: credential.trim() } : {}),
          is_enabled: enabled,
        },
      ]);
      onClose();
    } catch (error) {
      setErrorKey(getResearchErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalCore isOpen width={EModalWidth.MD} handleClose={() => !busy && onClose()}>
      <div className="flex w-full flex-col gap-3 p-4">
        <h3 className="text-sm font-medium text-primary">
          {connection
            ? `${t("research.integrations.edit_title")} · ${t(INTEGRATION_SYSTEM_LABELS[system as TIntegrationSystem] ?? system)}`
            : `${t("research.integrations.configure_title")} · ${t(INTEGRATION_SYSTEM_LABELS[system as TIntegrationSystem] ?? system)}`}
        </h3>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <ListFilterField label={t("research.integrations.display_name")} className="w-full">
              <ListFilterInput
                value={displayName}
                placeholder={t("research.integrations.display_name")}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </ListFilterField>
            <ListFilterField label={t("research.integrations.columns.credential_mode")} className="w-full">
              <ListFilterSelect
                value={credentialMode}
                onChange={(event) => {
                  setCredentialMode(event.target.value as "SHARED" | "PERSONAL");
                  setCredential("");
                }}
              >
                <option value="SHARED">{t("research.integrations.credential_mode_shared")}</option>
                <option value="PERSONAL">{t("research.integrations.credential_mode_personal")}</option>
              </ListFilterSelect>
            </ListFilterField>
          </div>
          <ListFilterField label={t("research.integrations.columns.base_url")} className="w-full">
            <ListFilterInput
              value={baseUrl}
              placeholder={baseUrl ? "" : t("research.integrations.base_url_hint")}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </ListFilterField>
          {credentialMode === "SHARED" && (
            <ListFilterField label="访问 Token" className="w-full">
              <ListFilterInput
                type="password"
                value={credential}
                placeholder={connection?.has_credential ? "已配置，留空保持不变" : "直接填写服务访问 Token"}
                onChange={(event) => setCredential(event.target.value)}
                autoComplete="off"
              />
            </ListFilterField>
          )}
        </div>
        <ListFilterCheckbox
          label={t("research.integrations.enabled")}
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        {errorKey && <p className="text-12 text-danger-primary">{t(errorKey)}</p>}
        <p className="text-11 text-tertiary">
          {credentialMode === "PERSONAL"
            ? "个人凭证模式：每位成员在个人设置里配置自己的 Token，公共连接不再保存密钥。"
            : connection?.has_credential
              ? t("research.integrations.credential_configured")
              : t("research.integrations.credential_hint")}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            {t("research.common.cancel")}
          </Button>
          <Button variant="primary" size="sm" onClick={() => void handleSave()} disabled={!baseUrl.trim() || busy}>
            {t("research.common.save")}
          </Button>
        </div>
      </div>
    </ModalCore>
  );
});
