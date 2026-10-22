/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { format } from "date-fns";
import { DeleteOutline, EditOutline } from "@makeplane/propel/icons";
import { useTranslation } from "@plane/i18n";
import { API_TOKENS_LIST } from "@plane/constants";
import { Button } from "@plane/propel/button";
import { APITokenService } from "@plane/services";
import type { IApiToken } from "@plane/types";
import { ModalCore, EModalPosition, EModalWidth } from "@plane/ui";
import { DeleteApiTokenModal } from "@/components/api-token/delete-token-modal";
import { tokenErrorKey } from "./error";

const service = new APITokenService();
const date = (value: string | null) => (value ? format(new Date(value), "yyyy-MM-dd") : "—");
const actionClass =
  "rounded p-2 text-secondary hover:bg-surface-2 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50";

export function ApiTokenListItem({ token }: { token: IApiToken }) {
  const { t } = useTranslation();
  const { mutate } = useSWRConfig();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [name, setName] = useState(token.label);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const active = token.is_active && (!token.expired_at || Date.parse(token.expired_at) > Date.now());

  function closeRename() {
    if (pending.current) return;
    setRenameOpen(false);
    setName("");
    setError("");
  }
  async function rename(event: React.FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    if (!name.trim() || name.trim().length > 255) {
      setError(t("api_token_management.name_required"));
      return;
    }
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      const result = await service.rename(token.id, name.trim());
      // Only update the display name in shared metadata, never a secret response.
      void mutate(
        API_TOKENS_LIST,
        (current: IApiToken[] | undefined) =>
          current?.map((item) => (item.id === token.id ? { ...item, label: result.label } : item)),
        { revalidate: true }
      ).catch(() => {
        /* The list provides its own refresh error and retry. */
      });
      pending.current = false;
      closeRename();
    } catch (failure) {
      const err = failure as { status?: number; detail?: string; label?: string[] };
      setError(
        err.label?.[0] ||
          err.detail ||
          t(err.status === 401 || err.status === 403 ? tokenErrorKey(err) : "api_token_management.rename_error")
      );
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return (
    <tr className="border-b border-subtle last:border-0">
      <td className="max-w-64 px-3 py-4 break-words">
        {token.label}
        {!active && <span className="ml-2 text-11 text-secondary">{t("api_token_management.inactive")}</span>}
      </td>
      <td className="font-mono px-3 py-4 text-13 whitespace-nowrap">{token.masked_token || "********"}</td>
      <td className="px-3 py-4 whitespace-nowrap" title={new Date(token.created_at).toLocaleString()}>
        {date(token.created_at)}
      </td>
      <td
        className="px-3 py-4 whitespace-nowrap"
        title={token.last_used ? new Date(token.last_used).toLocaleString() : t("api_token_management.never_used")}
      >
        {date(token.last_used)}
      </td>
      <td className="px-3 py-2">
        <div className="flex justify-end gap-1">
          <button
            type="button"
            className={actionClass}
            aria-label={`${t("api_token_management.rename")} ${token.label}`}
            title={t("api_token_management.rename")}
            onClick={() => {
              setName(token.label);
              setError("");
              setRenameOpen(true);
            }}
          >
            <EditOutline className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={actionClass}
            aria-label={`${t("delete")} ${token.label}`}
            title={t("delete")}
            onClick={() => setDeleteOpen(true)}
          >
            <DeleteOutline className="size-4" aria-hidden="true" />
          </button>
        </div>
        <DeleteApiTokenModal isOpen={deleteOpen} onClose={() => setDeleteOpen(false)} tokenId={token.id} />
        <ModalCore isOpen={renameOpen} handleClose={closeRename} position={EModalPosition.TOP} width={EModalWidth.XXL}>
          <form className="space-y-4 p-5" onSubmit={(event) => void rename(event)}>
            <h3 className="text-16 font-medium">{t("api_token_management.rename")}</h3>
            <label className="block space-y-2">
              <span>{t("name")}</span>
              <input
                required
                maxLength={255}
                disabled={saving}
                aria-label={t("api_token_management.token_name")}
                className="w-full rounded border border-subtle bg-surface-1 px-3 py-2"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {error && (
              <p role="alert" className="text-danger-primary">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={closeRename} disabled={saving}>
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={saving || !name.trim()}>
                {saving ? t("saving") : t("save")}
              </Button>
            </div>
          </form>
        </ModalCore>
      </td>
    </tr>
  );
}
