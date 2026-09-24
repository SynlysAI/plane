/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { INVITE_CODE_STATUS_LABELS } from "@plane/constants";
import type { TAccountProvisioningOptions, TInviteCode, TResearchProfileCategory } from "@plane/types";
import { useTranslation } from "@plane/i18n";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import { Button } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { Input, Spinner } from "@plane/ui";
// services
import { ResearchAccountService } from "@/services/research/account.service";

const accountService = new ResearchAccountService();

const registrationLink = (code: TInviteCode) =>
  typeof window === "undefined" ? code.register_url : `${window.location.origin}${code.register_url}`;

type Props = {
  workspaceSlug: string;
};

/**
 * Invite codes are the only way into the deployment: the public workspace is
 * closed to open registration (SYS-INV-01 ~ SYS-INV-08).
 */
export const ResearchInviteCodeManager = observer(function ResearchInviteCodeManager({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const [codes, setCodes] = useState<TInviteCode[]>([]);
  const [options, setOptions] = useState<TAccountProvisioningOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    profile_category: TResearchProfileCategory;
    org_unit: string | null;
    primary_advisor: string | null;
    max_uses: number;
    expires_in_days: number;
    note: string;
  }>({ profile_category: "STUDENT", org_unit: null, primary_advisor: null, max_uses: 1, expires_in_days: 7, note: "" });

  const load = useCallback(async () => {
    try {
      setErrorKey(null);
      const [data, provisioningOptions] = await Promise.all([
        accountService.getInviteCodes(workspaceSlug),
        accountService.getAccountProvisioningOptions(workspaceSlug),
      ]);
      setCodes(data?.results ?? []);
      setOptions(provisioningOptions);
    } catch {
      setErrorKey("research.invite_codes.error.load");
    } finally {
      setLoading(false);
    }
  }, [workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      await accountService.createInviteCode(workspaceSlug, draft);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("research.invite_codes.toast.created_title"),
        message: t("research.invite_codes.toast.created_message"),
      });
      await load();
    } catch (error) {
      const payload = error as { error_code?: string } | undefined;
      setErrorKey(payload?.error_code ?? "research.invite_codes.error.create");
    } finally {
      setCreating(false);
    }
  }, [draft, load, t, workspaceSlug]);

  const handleToggle = useCallback(
    async (code: TInviteCode) => {
      const action = code.status === "ACTIVE" ? "disable" : "enable";
      try {
        await accountService.toggleInviteCode(workspaceSlug, code.id, action);
        await load();
      } catch {
        setErrorKey("research.invite_codes.error.update");
      }
    },
    [load, workspaceSlug]
  );

  const handleDelete = useCallback(
    async (code: TInviteCode) => {
      try {
        await accountService.deleteInviteCode(workspaceSlug, code.id);
        await load();
      } catch {
        setErrorKey("research.invite_codes.error.delete");
      }
    },
    [load, workspaceSlug]
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-subtle p-3">
        <label className="flex flex-col gap-1 text-11 text-tertiary">
          {t("research.invite_codes.fields.profile_category")}
          <select
            className="rounded border border-subtle bg-transparent px-2 py-1.5 text-12 text-primary"
            value={draft.profile_category}
            onChange={(event) =>
              setDraft((prev) => ({ ...prev, profile_category: event.target.value as TResearchProfileCategory }))
            }
          >
            {(options?.profile_categories ?? []).map((category) => (
              <option key={category.value} value={category.value}>
                {category.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-11 text-tertiary">
          {t("research.invite_codes.fields.primary_org_unit")}
          <select
            className="max-w-72 rounded border border-subtle bg-transparent px-2 py-1.5 text-12 text-primary"
            value={draft.org_unit ?? ""}
            onChange={(event) => setDraft((prev) => ({ ...prev, org_unit: event.target.value || null }))}
          >
            <option value="">{t("research.invite_codes.fields.unassigned")}</option>
            {(options?.org_units ?? []).map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.display_path}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-11 text-tertiary">
          {t("research.invite_codes.fields.primary_advisor")}
          <select
            className="max-w-64 rounded border border-subtle bg-transparent px-2 py-1.5 text-12 text-primary"
            value={draft.primary_advisor ?? ""}
            onChange={(event) => setDraft((prev) => ({ ...prev, primary_advisor: event.target.value || null }))}
          >
            <option value="">{t("research.invite_codes.fields.unassigned")}</option>
            {(options?.advisors ?? []).map((advisor) => (
              <option key={advisor.id} value={advisor.id}>
                {advisor.display_name || advisor.email}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-11 text-tertiary">
          {t("research.invite_codes.fields.max_uses")}
          <Input
            type="number"
            min={1}
            value={draft.max_uses}
            onChange={(event) => setDraft((prev) => ({ ...prev, max_uses: Number(event.target.value) || 1 }))}
            className="w-24 text-12"
          />
        </label>
        <label className="flex flex-col gap-1 text-11 text-tertiary">
          {t("research.invite_codes.fields.expires_in_days")}
          <Input
            type="number"
            min={0}
            value={draft.expires_in_days}
            onChange={(event) => setDraft((prev) => ({ ...prev, expires_in_days: Number(event.target.value) || 0 }))}
            className="w-24 text-12"
          />
        </label>
        <label className="flex flex-col gap-1 text-11 text-tertiary">
          {t("research.invite_codes.fields.note")}
          <Input
            value={draft.note}
            onChange={(event) => setDraft((prev) => ({ ...prev, note: event.target.value }))}
            className="w-48 text-12"
          />
        </label>
        <Button variant="primary" size="sm" loading={creating} onClick={handleCreate}>
          {t("research.invite_codes.actions.create")}
        </Button>
      </div>

      {errorKey && <p className="text-12 text-danger-primary">{t(errorKey)}</p>}

      {loading ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : codes.length === 0 ? (
        <p className="text-12 text-tertiary">{t("research.invite_codes.empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-subtle">
          <Table>
            <TableHeader className="bg-surface-2 text-11 text-tertiary">
              <TableRow>
                <TableHead>{t("research.invite_codes.columns.code")}</TableHead>
                <TableHead>{t("research.invite_codes.columns.profile_category")}</TableHead>
                <TableHead>{t("research.invite_codes.columns.primary_org_unit")}</TableHead>
                <TableHead>{t("research.invite_codes.columns.primary_advisor")}</TableHead>
                <TableHead>{t("research.invite_codes.columns.usage")}</TableHead>
                <TableHead>{t("research.invite_codes.columns.expires_at")}</TableHead>
                <TableHead>{t("research.invite_codes.columns.status")}</TableHead>
                <TableHead>{t("research.invite_codes.columns.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {codes.map((code) => (
                <TableRow key={code.id}>
                  <TableCell className="font-mono text-11 text-primary">
                    <button
                      type="button"
                      className="hover:text-accent-primary"
                      onClick={() => void navigator.clipboard?.writeText(registrationLink(code))}
                    >
                      {code.code}
                    </button>
                  </TableCell>
                  <TableCell className="text-secondary">
                    {code.profile_category || (code.provisioning_version === 1 ? "Legacy v1" : "-")}
                  </TableCell>
                  <TableCell className="text-secondary">
                    {options?.org_units.find((unit) => unit.id === code.org_unit)?.display_path ?? "-"}
                  </TableCell>
                  <TableCell className="text-secondary">
                    {options?.advisors.find((advisor) => advisor.id === code.primary_advisor)?.display_name ?? "-"}
                  </TableCell>
                  <TableCell className="text-secondary">
                    {code.used_count} / {code.max_uses}
                  </TableCell>
                  <TableCell className="text-secondary">
                    {code.expires_at ? new Date(code.expires_at).toLocaleString() : "-"}
                  </TableCell>
                  <TableCell className="text-secondary">
                    {t(INVITE_CODE_STATUS_LABELS[code.effective_status] ?? "research.invite_codes.status.active")}
                  </TableCell>
                  <TableCell className="flex gap-2">
                    <button type="button" className="text-accent-primary" onClick={() => void handleToggle(code)}>
                      {code.status === "ACTIVE"
                        ? t("research.invite_codes.actions.disable")
                        : t("research.invite_codes.actions.enable")}
                    </button>
                    <button type="button" className="text-danger-primary" onClick={() => void handleDelete(code)}>
                      {t("research.invite_codes.actions.delete")}
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
});

export default ResearchInviteCodeManager;
