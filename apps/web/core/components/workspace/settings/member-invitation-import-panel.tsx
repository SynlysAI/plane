/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { type FormEvent, useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import type { TResearchProfileCategory } from "@plane/types";
import { Button } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { ListFilterCheckbox, ListFilterField, ListFilterInput, ListFilterSelect } from "@plane/ui";
// components
import { ResearchFilterToolbar } from "@/components/research/common/research-data-surface";
// hooks
import { useMember } from "@/hooks/store/use-member";
// services
import { WorkspaceService } from "@/services/workspace.service";

const service = new WorkspaceService();

const PROFILE_CATEGORIES: { value: TResearchProfileCategory; label: string }[] = [
  { value: "STUDENT", label: "学生" },
  { value: "POSTDOC", label: "博士后" },
  { value: "ADVISOR", label: "导师" },
  { value: "PI", label: "PI" },
  { value: "STAFF", label: "员工" },
  { value: "OTHER", label: "其他" },
];

const WORKSPACE_ROLE_LABELS: Record<number, string> = {
  5: "访客",
  15: "成员",
  20: "管理员",
};

type ImportErrorRow = {
  email?: string;
  message: string;
  name?: string;
  row_number?: number | null;
};

type Props = {
  workspaceSlug: string;
};

/**
 * Plain workspace invitations: send individual or Excel invitations without
 * creating accounts or research organization relations.
 */
export const PlainWorkspaceMemberImportPanel = observer(function PlainWorkspaceMemberImportPanel({
  workspaceSlug,
}: Props) {
  const [mode, setMode] = useState<"single" | "excel">("single");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<number>(15);
  const [profileEnabled, setProfileEnabled] = useState(false);
  const [profileCategory, setProfileCategory] = useState<TResearchProfileCategory>("OTHER");
  const [busy, setBusy] = useState(false);
  const [loadingInvitations, setLoadingInvitations] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [errorRows, setErrorRows] = useState<ImportErrorRow[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const {
    workspace: { workspaceMemberInvitations, fetchWorkspaceMemberInvitations, inviteMembersToWorkspace },
  } = useMember();

  useEffect(() => {
    let current = true;
    setLoadingInvitations(true);
    fetchWorkspaceMemberInvitations(workspaceSlug)
      .then(() => {
        if (current) setLoadError("");
        return undefined;
      })
      .catch(() => {
        if (current) setLoadError("待处理邀请加载失败，请刷新重试。");
      })
      .finally(() => {
        if (current) setLoadingInvitations(false);
      });
    return () => {
      current = false;
    };
  }, [fetchWorkspaceMemberInvitations, workspaceSlug]);

  const invitations = workspaceMemberInvitations?.[workspaceSlug] ?? [];
  const profileLabel = (value: string) => PROFILE_CATEGORIES.find((item) => item.value === value)?.label ?? value;
  const roleLabel = (value: number) => WORKSPACE_ROLE_LABELS[value] ?? String(value);

  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setErrorRows([]);
    try {
      await operation();
    } catch (submitError) {
      const payload = submitError as { error?: string; message?: string; rows?: ImportErrorRow[] };
      setErrorRows(payload?.rows ?? []);
      setError(payload?.error || payload?.message || "邀请发送失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const submitSingle = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await run(async () => {
      await inviteMembersToWorkspace(workspaceSlug, {
        emails: [
          {
            display_name: displayName,
            email,
            role: role as 5 | 15 | 20,
            research_profile_enabled: profileEnabled,
            research_profile_category: profileEnabled ? profileCategory : undefined,
          },
        ],
      });
      setDisplayName("");
      setEmail("");
      setToast({ type: TOAST_TYPE.SUCCESS, title: "邀请已发送", message: "受邀人接受后将加入当前普通工作区。" });
    });
  };

  const changeMode = (nextMode: "single" | "excel") => {
    setMode(nextMode);
    setError("");
    setErrorRows([]);
  };

  const submitError = error ? (
    <div role="alert" className="flex flex-col gap-1 text-12 text-danger-primary">
      <p>{error}</p>
      {errorRows.map((row) => (
        <p key={`${row.row_number ?? ""}-${row.email ?? ""}`}>
          第 {row.row_number ?? "-"} 行{row.email ? ` · ${row.email}` : ""}：{row.message}
        </p>
      ))}
    </div>
  ) : null;

  const submitExcel = async () => {
    const file = fileInput.current?.files?.[0];
    if (!file) {
      setError("请先选择成员 Excel 或 CSV 文件。");
      setErrorRows([]);
      return;
    }
    await run(async () => {
      const result = await service.importWorkspaceMemberInvitations(workspaceSlug, {
        file,
        research_profile_enabled: profileEnabled,
        research_profile_category: profileEnabled ? profileCategory : undefined,
      });
      await fetchWorkspaceMemberInvitations(workspaceSlug);
      if (fileInput.current) fileInput.current.value = "";
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: "批量邀请已发送",
        message: `已创建 ${result.created} 条待处理邀请。`,
      });
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <ResearchFilterToolbar>
        {(
          [
            ["single", "单个邀请"],
            ["excel", "Excel 导入"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            disabled={busy}
            className={`h-8 rounded-md px-3 text-13 transition-colors ${
              mode === value ? "bg-surface-2 text-primary" : "text-secondary hover:text-primary"
            }`}
            onClick={() => changeMode(value)}
          >
            {label}
          </button>
        ))}
        <a
          className="text-12 text-accent-primary"
          href={service.getWorkspaceMemberInvitationTemplateUrl(workspaceSlug)}
        >
          下载三列模板
        </a>
      </ResearchFilterToolbar>

      <p className="text-11 text-tertiary">
        普通工作区导入只发送成员邀请，不创建账号、初始密码或组织关系。受邀人接受后才加入当前工作区。
      </p>

      <section>
        <div className="flex items-center justify-between">
          <h4 className="text-13 font-medium text-primary">待处理邀请</h4>
          <span className="text-11 text-tertiary">{invitations.length} 条</span>
        </div>
        <div className="mt-2 divide-y divide-subtle">
          {loadingInvitations ? (
            <p className="py-3 text-12 text-tertiary">加载中…</p>
          ) : loadError ? (
            <p role="alert" className="py-3 text-12 text-danger-primary">
              {loadError}
            </p>
          ) : invitations.length === 0 ? (
            <p className="py-3 text-12 text-tertiary">暂无待处理邀请。</p>
          ) : (
            invitations.map((invitation) => (
              <div key={invitation.id} className="grid grid-cols-1 gap-1 py-2.5 sm:grid-cols-[1.2fr_1.6fr_.7fr_.9fr]">
                <span className="truncate text-12 text-primary">{invitation.display_name || "未填写名称"}</span>
                <span className="truncate text-12 text-secondary">{invitation.email}</span>
                <span className="text-12 text-secondary">{roleLabel(invitation.role)}</span>
                <span className="text-12 text-tertiary">
                  {invitation.research_profile_enabled
                    ? `基础科研档案 · ${profileLabel(invitation.research_profile_category ?? "OTHER")}`
                    : "未开通科研档案"}
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      {mode === "single" ? (
        <form className="flex flex-col gap-4" onSubmit={submitSingle}>
          <fieldset disabled={busy} className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <ListFilterField label="名称 *" className="w-full">
              <ListFilterInput
                required
                value={displayName}
                maxLength={255}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </ListFilterField>
            <ListFilterField label="邮箱 *" className="w-full">
              <ListFilterInput
                required
                type="email"
                value={email}
                maxLength={255}
                onChange={(event) => setEmail(event.target.value)}
              />
            </ListFilterField>
            <ListFilterField label="工作区角色 *" className="w-full">
              <ListFilterSelect value={role} onChange={(event) => setRole(Number(event.target.value))}>
                {Object.entries(WORKSPACE_ROLE_LABELS).map(([value, label]) => (
                  <option key={value} value={Number(value)}>
                    {label}
                  </option>
                ))}
              </ListFilterSelect>
            </ListFilterField>
          </fieldset>
          <fieldset disabled={busy} className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <ListFilterCheckbox
              label="同步创建基础科研档案"
              checked={profileEnabled}
              onChange={(event) => setProfileEnabled(event.target.checked)}
            />
            <ListFilterField label="科研档案类别" className="w-full">
              <ListFilterSelect
                disabled={!profileEnabled}
                value={profileCategory}
                onChange={(event) => setProfileCategory(event.target.value as TResearchProfileCategory)}
              >
                {PROFILE_CATEGORIES.map((category) => (
                  <option key={category.value} value={category.value}>
                    {category.label}
                  </option>
                ))}
              </ListFilterSelect>
            </ListFilterField>
            <p className="self-end text-11 text-tertiary">
              仅创建档案，不建立组织关系；完整科研身份请切换到科研身份成员。
            </p>
          </fieldset>
          {submitError}
          <Button type="submit" variant="primary" size="xl" loading={busy} disabled={busy}>
            发送邀请
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <fieldset disabled={busy} className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <ListFilterField label="成员表（名称、邮箱、角色）" className="w-full md:col-span-2">
              <ListFilterInput ref={fileInput} type="file" accept=".csv,.xlsx" disabled={busy} />
            </ListFilterField>
            <ListFilterCheckbox
              label="同步创建基础科研档案"
              checked={profileEnabled}
              onChange={(event) => setProfileEnabled(event.target.checked)}
            />
            <ListFilterField label="科研档案类别" className="w-full">
              <ListFilterSelect
                disabled={!profileEnabled}
                value={profileCategory}
                onChange={(event) => setProfileCategory(event.target.value as TResearchProfileCategory)}
              >
                {PROFILE_CATEGORIES.map((category) => (
                  <option key={category.value} value={category.value}>
                    {category.label}
                  </option>
                ))}
              </ListFilterSelect>
            </ListFilterField>
            <p className="text-11 text-tertiary md:col-span-3">
              Excel 保持三列，不采集组织、导师或学号。任一行无效时整批不发送。
            </p>
          </fieldset>
          {submitError}
          <Button variant="primary" size="xl" loading={busy} disabled={busy} onClick={() => void submitExcel()}>
            上传并发送邀请
          </Button>
        </div>
      )}
    </div>
  );
});
