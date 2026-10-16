/** Copyright (c) 2023-present Plane Software, Inc. and contributors. SPDX-License-Identifier: AGPL-3.0-only */
import { useCallback, useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import type { TAccountProvisioningOptions, TUserImportBatch, TUserImportBatchSummary } from "@plane/types";
import { Button } from "@plane/propel/button";
import { ListFilterField, ListFilterInput, ListFilterCheckbox } from "@plane/ui";
import { ResearchFilterToolbar } from "@/components/research/common/research-data-surface";
import { ResearchAccountService } from "@/services/research/account.service";
import { SingleImportForm } from "./single-import-form";
import { ImportReview } from "./import-review";

const service = new ResearchAccountService();
const statuses: Record<string, string> = {
  PENDING_REVIEW: "待审批",
  IMPORTED: "已审批 · 已导入",
  REJECTED: "已驳回 · 未导入",
  PENDING: "待处理",
  FAILED: "导入失败",
};

const RESEARCH_IMPORT_TEMPLATES = {
  students: "/templates/research-student-import-template.xlsx",
  advisors: "/templates/research-advisor-mapping-template.xlsx",
} as const;

export function ResearchUserImportPanel({
  workspaceSlug,
  onRelationsChanged,
}: {
  workspaceSlug: string;
  onRelationsChanged?: (batch: TUserImportBatch) => Promise<void>;
}) {
  const [mode, setMode] = useState("bulk");
  const [resetPasswords, setResetPasswords] = useState(false);
  const [batch, setBatch] = useState<TUserImportBatch | null>(null);
  const [history, setHistory] = useState<TUserImportBatchSummary[]>([]);
  const [options, setOptions] = useState<TAccountProvisioningOptions | null>(null);
  const [busy, setBusy] = useState(false),
    [reviewBusy, setReviewBusy] = useState(false);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const students = useRef<HTMLInputElement>(null),
    advisors = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  useEffect(() => {
    let current = true;
    setLoading(true);
    Promise.all([service.getUserImports(workspaceSlug), service.getAccountProvisioningOptions(workspaceSlug)])
      .then(([data, opts]) => {
        if (current) {
          setHistory(data.results ?? []);
          setOptions(opts);
        }
        return undefined;
      })
      .catch(() => {
        if (current) setError("导入记录或人员候选加载失败，请刷新重试。");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [workspaceSlug]);
  const accept = useCallback(
    (next: TUserImportBatch) => {
      setBatch(next);
      setHistory((items) => [next, ...items.filter((item) => item.id !== next.id)]);
      if (next.status === "IMPORTED")
        void service
          .getAccountProvisioningOptions(workspaceSlug)
          .then(setOptions)
          .catch(() => setError("人员已导入，候选刷新失败，请刷新页面。"));
    },
    [workspaceSlug]
  );
  const refreshRelations = useCallback(
    async (updatedBatch: TUserImportBatch) => {
      const outcomes = await Promise.allSettled([
        onRelationsChanged?.(updatedBatch) ?? Promise.resolve(),
        service.getAccountProvisioningOptions(workspaceSlug).then(setOptions),
      ]);
      if (outcomes.some((outcome) => outcome.status === "rejected")) {
        setError("人员已写入，但组织成员或候选刷新失败，请刷新页面核对。");
      }
    },
    [onRelationsChanged, workspaceSlug]
  );
  const run = async (operation: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (failure) {
      const payload = failure as { message?: string; error_code?: string };
      setError(
        (payload?.error_code === "user_import_file_invalid" ? "文件无法解析，请检查表头与编码。 " : "") +
          (payload?.message || "导入失败。")
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ResearchFilterToolbar>
          {[
            ["single", "单条录入"],
            ["bulk", "批量导入"],
          ].map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={mode === value}
              disabled={busy || reviewBusy}
              className={`h-8 rounded-md px-3 text-13 ${
                mode === value ? "bg-surface-1 text-accent-primary" : "text-secondary"
              }`}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </ResearchFilterToolbar>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {mode === "bulk" && (
            <>
              <a
                href={RESEARCH_IMPORT_TEMPLATES.students}
                download="科研身份学生导入模板.xlsx"
                className="inline-flex h-8 items-center gap-1.5 text-12 text-accent-primary hover:underline"
              >
                <Download className="size-3.5 shrink-0" aria-hidden="true" />
                下载学生名册模板
              </a>
              <a
                href={RESEARCH_IMPORT_TEMPLATES.advisors}
                download="科研身份导师映射模板.xlsx"
                className="inline-flex h-8 items-center gap-1.5 text-12 text-accent-primary hover:underline"
              >
                <Download className="size-3.5 shrink-0" aria-hidden="true" />
                下载导师映射模板
              </a>
            </>
          )}
          <a className="text-12 text-accent-primary" href={service.getAccountInitialPasswordsUrl(workspaceSlug)}>
            下载全部初始密码
          </a>
        </div>
      </div>
      {mode === "single" ? (
        <fieldset disabled={reviewBusy}>
          <SingleImportForm workspaceSlug={workspaceSlug} options={options} onCreated={accept} onBusy={setBusy} />
        </fieldset>
      ) : (
        <>
          <ResearchFilterToolbar>
            <ListFilterField label="成员名册" className="w-full sm:w-64">
              <ListFilterInput ref={students} type="file" accept=".csv,.xlsx" disabled={busy || reviewBusy} />
            </ListFilterField>
            <ListFilterField label="导师姓名邮箱表（必传）" className="w-full sm:w-64">
              <ListFilterInput ref={advisors} type="file" accept=".csv,.xlsx" disabled={busy || reviewBusy} />
            </ListFilterField>
            <ListFilterCheckbox
              label="为已有账号重新生成初始密码"
              aria-label="为已有账号重新生成初始密码"
              checked={resetPasswords}
              disabled={busy || reviewBusy}
              onChange={(event) => setResetPasswords(event.target.checked)}
            />
            <Button
              variant="primary"
              size="xl"
              disabled={busy || reviewBusy}
              onClick={() =>
                void run(async () => {
                  const roster = students.current?.files?.[0],
                    mapping = advisors.current?.files?.[0];
                  if (!roster || !mapping) {
                    setError("请先选择成员名册和导师姓名邮箱表。");
                    return;
                  }
                  accept(
                    await service.importUsers(workspaceSlug, {
                      students: roster,
                      advisors: mapping,
                      reset_passwords: resetPasswords,
                    })
                  );
                })
              }
            >
              上传并预览
            </Button>
          </ResearchFilterToolbar>
          <p className="text-11 text-tertiary">
            默认不覆盖已有账号密码。勾选后，本次会为表中的已有账号重新生成初始密码，并要求下次登录修改。下载到的是最近一次发放的初始密码，不是用户改密后的当前密码。已有成员未勾选时不能再次纳入；可引用已有导师。MS、Ph.D
            按学生导入；电话兼容“手机号”。学号可留空，填写后将参与唯一性校验。
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="text-12 text-danger-primary">
          {error}
        </p>
      )}
      {batch && (
        <ImportReview
          key={batch.id}
          batch={batch}
          workspaceSlug={workspaceSlug}
          options={options}
          onChange={accept}
          onBusy={setReviewBusy}
          onRelationsChanged={refreshRelations}
        />
      )}
      <section>
        <h4 className="text-13">最近导入</h4>
        {loading ? (
          <p>加载中…</p>
        ) : !history.length ? (
          <p className="text-12 text-tertiary">暂无导入记录。</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {history.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-2 p-2">
                <button
                  disabled={busy || reviewBusy}
                  className="text-left text-12"
                  onClick={() => void run(async () => accept(await service.getUserImport(workspaceSlug, item.id!)))}
                >
                  {item.source_filename} · {statuses[item.status]} · 共 {item.rows_total} 行 · 校验通过 {item.rows_ok}
                  {item.review_counts &&
                    ` · 待审核 ${item.review_counts.pending} · 已纳入 ${item.review_counts.included} · 已排除 ${item.review_counts.excluded}`}
                </button>
                {item.status === "IMPORTED" && (
                  <a
                    className="text-12 text-accent-primary"
                    href={service.getUserImportReportUrl(workspaceSlug, item.id!)}
                  >
                    下载导入报告
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
export default ResearchUserImportPanel;
