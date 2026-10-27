"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Avatar } from "@makeplane/propel/components/avatar";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import type { TTaskNotificationRecipients } from "@plane/types";
import { cn, getFileURL } from "@plane/utils";
import { AvatarGroupOverflow } from "@/components/common/avatar-group-overflow";

type Props = {
  /** Load the server-authoritative notification-member contract. */
  load: () => Promise<TTaskNotificationRecipients>;
  /** Replace the carbon-copy list and return the refreshed contract. */
  save: (userIds: string[]) => Promise<TTaskNotificationRecipients>;
  /** Toggle only the current user's self subscription. */
  setSelfSubscribed: (subscribed: boolean) => Promise<TTaskNotificationRecipients>;
};

/**
 * Render the shared task notification footer and member editor.
 *
 * Args:
 *   load: Loader for candidates, groups, recipients, and current permissions.
 *   save: Full carbon-copy list save operation.
 *   setSelfSubscribed: Current-user subscription toggle operation.
 */
export function TaskNotificationRecipients({ load, save, setSelfSubscribed }: Props) {
  const { t } = useTranslation();
  const [payload, setPayload] = useState<TTaskNotificationRecipients | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draftIds, setDraftIds] = useState<string[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [selfBusy, setSelfBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const nextPayload = await load();
      setPayload(nextPayload);
    } catch {
      setPayload(null);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const recipients = useMemo(() => {
    if (!payload) return [];
    const recipientIds = new Set(payload.recipient_user_ids);
    return payload.candidates.filter((candidate) => recipientIds.has(candidate.id));
  }, [payload]);

  const candidateGroups = useMemo(() => {
    if (!payload) return [];
    return payload.groups.filter((group) => payload.candidates.some((item) => item.group_ids.includes(group.id)));
  }, [payload]);

  const visibleCandidates = useMemo(() => {
    if (!payload) return [];
    const normalizedQuery = query.trim().toLowerCase();
    return payload.candidates.filter((candidate) => {
      const inGroup = !activeGroupId || candidate.group_ids.includes(activeGroupId);
      const matchesQuery =
        !normalizedQuery || `${candidate.display_name} ${candidate.email}`.toLowerCase().includes(normalizedQuery);
      return inGroup && matchesQuery;
    });
  }, [activeGroupId, payload, query]);

  const fixedIds = useMemo(() => new Set(payload?.fixed_user_ids ?? []), [payload]);
  const selectedCount = draftIds.length;
  const canManage = payload?.can_manage === true;
  const selfLabel = payload?.current_user_self_subscribed
    ? t("task_notification_members.stop_notifying_me")
    : payload?.current_user_subscribed
      ? t("task_notification_members.currently_notified")
      : t("task_notification_members.notify_me");
  const selfDisabled =
    selfBusy || loading || !payload || (payload.current_user_subscribed && !payload.current_user_self_subscribed);

  const openEditor = () => {
    if (!payload || !canManage) return;
    setDraftIds(payload.selected_user_ids);
    setActiveGroupId(null);
    setQuery("");
    setActionError("");
    setEditorOpen(true);
  };

  const toggleDraftMember = (userId: string, checked: boolean) => {
    setDraftIds((current) => {
      if (fixedIds.has(userId)) return current;
      return checked ? [...new Set([...current, userId])] : current.filter((id) => id !== userId);
    });
  };

  const submitMembers = async () => {
    if (!payload || saving) return;
    setSaving(true);
    setActionError("");
    try {
      const nextPayload = await save(draftIds);
      setPayload(nextPayload);
      setEditorOpen(false);
    } catch {
      setActionError(t("task_notification_members.save_failed"));
    } finally {
      setSaving(false);
    }
  };

  const toggleSelf = async () => {
    if (!payload || selfBusy || selfDisabled) return;
    const subscribed = !payload.current_user_self_subscribed;
    setSelfBusy(true);
    setActionError("");
    try {
      const nextPayload = await setSelfSubscribed(subscribed);
      setPayload(nextPayload);
    } catch {
      setActionError(t("task_notification_members.self_failed"));
    } finally {
      setSelfBusy(false);
    }
  };

  if (loading && !payload) {
    return (
      <p role="status" className="mt-4 border-t border-subtle pt-3 text-12 text-tertiary">
        {t("loading")}
      </p>
    );
  }

  if (loadError) {
    return (
      <div role="alert" className="mt-4 flex flex-wrap items-center gap-2 border-t border-subtle pt-3 text-12">
        <span className="text-danger-primary">{t("task_notification_members.load_failed")}</span>
        <Button variant="secondary" size="sm" onClick={() => void reload()}>
          {t("task_notification_members.retry")}
        </Button>
      </div>
    );
  }

  if (!payload) return null;

  return (
    <section
      aria-label={t("task_notification_members.label")}
      className="mt-4 border-t border-subtle pt-3"
      data-task-notification-recipients=""
    >
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-12 text-secondary">{t("task_notification_members.label")}</span>
        {recipients.length ? (
          <AvatarGroupOverflow size="xs" max={5}>
            {recipients.map((member) => (
              <Avatar
                key={member.id}
                alt={member.display_name}
                fallback={member.display_name.slice(0, 1)}
                src={getFileURL(member.avatar_url ?? "")}
              />
            ))}
          </AvatarGroupOverflow>
        ) : (
          <span className="text-12 text-tertiary">{t("task_notification_members.empty")}</span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" disabled={!canManage} onClick={openEditor}>
            {t("task_notification_members.edit")}
          </Button>
          <Button variant="secondary" size="sm" disabled={selfDisabled} onClick={() => void toggleSelf()}>
            {selfBusy ? t("loading") : selfLabel}
          </Button>
        </div>
      </div>
      {actionError && (
        <p role="alert" className="mt-2 text-12 text-danger-primary">
          {actionError}
        </p>
      )}
      <ModalCore
        isOpen={editorOpen}
        handleClose={() => !saving && setEditorOpen(false)}
        position={EModalPosition.CENTER}
        width={EModalWidth.XXXL}
      >
        <div className="px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-16 font-semibold text-primary">{t("task_notification_members.title")}</h3>
            <span className="text-12 text-tertiary">
              {t("task_notification_members.selected_count", { count: selectedCount })}
            </span>
          </div>
          <input
            type="search"
            value={query}
            className="mt-3 w-full rounded-md border border-subtle bg-surface-1 px-3 py-2 text-13 text-primary"
            placeholder={t("task_notification_members.search")}
            aria-label={t("task_notification_members.search")}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label={t("task_notification_members.all")}>
            <button
              type="button"
              aria-pressed={activeGroupId === null}
              onClick={() => setActiveGroupId(null)}
              className={cn(
                "rounded-sm px-2 py-1 text-12",
                activeGroupId === null ? "bg-surface-2 font-medium text-primary" : "text-secondary hover:bg-surface-2"
              )}
            >
              {t("task_notification_members.all")}
            </button>
            {candidateGroups.map((group) => (
              <button
                key={group.id}
                type="button"
                aria-pressed={activeGroupId === group.id}
                onClick={() => setActiveGroupId(group.id)}
                className={cn(
                  "rounded-sm px-2 py-1 text-12",
                  activeGroupId === group.id
                    ? "bg-surface-2 font-medium text-primary"
                    : "text-secondary hover:bg-surface-2"
                )}
              >
                {group.name}
              </button>
            ))}
          </div>
          <div className="mt-3 max-h-72 overflow-y-auto border-t border-subtle">
            {visibleCandidates.map((candidate) => {
              const checked = draftIds.includes(candidate.id);
              const fixed = fixedIds.has(candidate.id);
              return (
                <label
                  key={candidate.id}
                  className="flex cursor-pointer items-center gap-3 border-b border-subtle px-1 py-2 last:border-b-0 hover:bg-surface-2"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={fixed}
                    className="accent-accent-primary size-4"
                    onChange={(event) => toggleDraftMember(candidate.id, event.target.checked)}
                  />
                  <Avatar
                    size="2xs"
                    alt={candidate.display_name}
                    fallback={candidate.display_name.slice(0, 1)}
                    src={getFileURL(candidate.avatar_url ?? "")}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-13 text-primary">{candidate.display_name}</span>
                    <span className="block truncate text-11 text-tertiary">{candidate.email}</span>
                  </span>
                  {fixed && <span className="text-11 text-tertiary">{t("task_notification_members.fixed")}</span>}
                </label>
              );
            })}
            {!visibleCandidates.length && (
              <p className="px-1 py-3 text-12 text-tertiary">{t("task_notification_members.empty_candidates")}</p>
            )}
          </div>
          <p className="mt-3 text-11 text-tertiary">{t("task_notification_members.fixed_hint")}</p>
          {actionError && (
            <p role="alert" className="mt-2 text-12 text-danger-primary">
              {actionError}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" size="sm" disabled={saving} onClick={() => setEditorOpen(false)}>
              {t("cancel")}
            </Button>
            <Button variant="primary" size="sm" disabled={saving} onClick={() => void submitMembers()}>
              {saving ? t("loading") : t("task_notification_members.save")}
            </Button>
          </div>
        </div>
      </ModalCore>
    </section>
  );
}
