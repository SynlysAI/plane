"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type {
  TResearchAssignableUser,
  TResearchChainNodeTask,
  TResearchChainNodeTaskAction,
  TResearchChainNodeTaskCreatePayload,
} from "@plane/types";
import { formatResearchDate, formatResearchDateTime } from "@/components/research/common/research-format";
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import { ResearchAssigneeSelect } from "@/components/research/chains/research-assignee-select";
import { ResearchChainTaskService } from "@/services/research/chain-task.service";

type Props = {
  workspaceSlug: string;
  chainId: string;
  nodeId: string;
};

type TPanelState = "loading" | "ready" | "forbidden" | "error";
type TCandidateState = "loading" | "ready" | "forbidden" | "error";

type TTaskFormState = {
  taskId: string | null;
  title: string;
  instruction: string;
  assignee: string;
  dueAt: string;
};

type TReasonActionState = {
  taskId: string;
  action: Extract<TResearchChainNodeTaskAction, "return" | "cancel">;
  reason: string;
};

const EMPTY_FORM: TTaskFormState = {
  taskId: null,
  title: "",
  instruction: "",
  assignee: "",
  dueAt: "",
};

const TASK_STATUS_KEYS: Record<TResearchChainNodeTask["status"], string> = {
  DRAFT: "research.chain_tasks.status.draft",
  ASSIGNED: "research.chain_tasks.status.assigned",
  SUBMITTED: "research.chain_tasks.status.submitted",
  NEEDS_REVISION: "research.chain_tasks.status.needs_revision",
  COMPLETED: "research.chain_tasks.status.completed",
  CANCELLED: "research.chain_tasks.status.cancelled",
};

/**
 * Convert an ISO deadline to the value shape accepted by a date input.
 *
 * Args:
 *   value: Backend ISO timestamp or null.
 *
 * Returns:
 *   A yyyy-mm-dd string, or an empty string when no deadline exists.
 */
function toDateInput(value: string | null | undefined) {
  return value ? value.slice(0, 10) : "";
}

/**
 * Resolve the display name from a task's compact user projection.
 *
 * Args:
 *   user: Assignee or assigning-user projection returned by the task API.
 *
 * Returns:
 *   Human-readable name, or an em dash when absent.
 */
function userName(user: { id: string; display_name: string } | null | undefined) {
  return user?.display_name || "—";
}

/**
 * Read a human-readable rejection message from a research API error body.
 *
 * Args:
 *   error: Object thrown by the chain-task service.
 *   fallback: Translation shown when the server provides no useful text.
 *
 * Returns:
 *   The safest available server-side rejection description.
 */
function serverErrorMessage(error: unknown, fallback: string) {
  const payload = error as { error?: unknown; detail?: unknown; error_code?: string } | undefined;
  if (typeof payload?.error === "string" && payload.error.trim()) return payload.error;
  if (typeof payload?.detail === "string" && payload.detail.trim()) return payload.detail;
  return payload?.error_code ? `${fallback} (${payload.error_code})` : fallback;
}

/**
 * Determine whether the server explicitly allows one task action.
 *
 * Args:
 *   task: Task carrying the capability map.
 *   action: Requested action key.
 *
 * Returns:
 *   True only when the backend marked the action allowed.
 */
function isTaskActionAllowed(task: TResearchChainNodeTask, action: TResearchChainNodeTaskAction) {
  return task.capabilities?.actions[action]?.allowed === true;
}

/** Load, edit, assign and review tasks attached to one Research Chain node. */
export function ResearchChainTaskPanel({ workspaceSlug, chainId, nodeId }: Props) {
  const { t, currentLocale } = useTranslation();
  const taskService = useMemo(() => new ResearchChainTaskService(), []);
  const [tasks, setTasks] = useState<TResearchChainNodeTask[]>([]);
  const [candidates, setCandidates] = useState<TResearchAssignableUser[]>([]);
  const [state, setState] = useState<TPanelState>("loading");
  const [candidateState, setCandidateState] = useState<TCandidateState>("loading");
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<TTaskFormState>(EMPTY_FORM);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [reasonAction, setReasonAction] = useState<TReasonActionState | null>(null);
  const [actionBusy, setActionBusy] = useState("");
  const [actionError, setActionError] = useState("");

  const load = useCallback(
    async (isActive: () => boolean = () => true) => {
      setState("loading");
      setCandidateState("loading");
      setActionError("");
      const [taskResult, candidateResult] = await Promise.allSettled([
        taskService.getNodeTasks(workspaceSlug, chainId, nodeId),
        taskService.getAssignableUsers(workspaceSlug, chainId),
      ]);

      if (!isActive()) return;
      if (taskResult.status === "rejected") {
        const errorCode = (taskResult.reason as { error_code?: string })?.error_code;
        setState(errorCode === "research_permission_denied" ? "forbidden" : "error");
        return;
      }

      setTasks(taskResult.value);
      setState("ready");
      if (candidateResult.status === "fulfilled") {
        setCandidates(candidateResult.value);
        setCandidateState("ready");
      } else {
        setCandidates([]);
        const errorCode = (candidateResult.reason as { error_code?: string })?.error_code;
        setCandidateState(errorCode === "research_permission_denied" ? "forbidden" : "error");
      }
    },
    [chainId, nodeId, taskService, workspaceSlug]
  );

  useEffect(() => {
    let active = true;
    setFormOpen(false);
    setForm(EMPTY_FORM);
    setReasonAction(null);
    void load(() => active);
    return () => {
      active = false;
    };
  }, [load]);

  /**
   * Replace or prepend one task without changing the server's list order.
   *
   * Args:
   *   task: Latest serialized task returned after a mutation.
   */
  const upsertTask = useCallback((task: TResearchChainNodeTask) => {
    setTasks((current) => {
      const index = current.findIndex((item) => item.id === task.id);
      if (index === -1) return [task, ...current];
      return [...current.slice(0, index), task, ...current.slice(index + 1)];
    });
  }, []);

  /** Open the create form with no inherited task values. */
  const startCreate = () => {
    setForm(EMPTY_FORM);
    setFormOpen(true);
    setFormError("");
    setActionError("");
  };

  /**
   * Open the editor from an existing task.
   *
   * Args:
   *   task: Task whose editable fields should populate the form.
   */
  const startEdit = (task: TResearchChainNodeTask) => {
    setForm({
      taskId: task.id,
      title: task.title,
      instruction: task.instruction,
      assignee: task.assignee ?? "",
      dueAt: toDateInput(task.due_at),
    });
    setFormOpen(true);
    setFormError("");
    setActionError("");
  };

  /** Validate and submit the create/edit/assign form. */
  const submitForm = async () => {
    if (!form.title.trim()) {
      setFormError(t("research.chain_tasks.title_required"));
      return;
    }
    const existing = form.taskId ? tasks.find((task) => task.id === form.taskId) : undefined;
    if (existing?.assignee && !form.assignee) {
      setFormError(t("research.chain_tasks.assignee_required"));
      return;
    }
    setFormBusy(true);
    setFormError("");
    try {
      const payload: TResearchChainNodeTaskCreatePayload = {
        title: form.title.trim(),
        instruction: form.instruction.trim(),
        assignee: form.assignee || null,
        due_at: form.dueAt ? `${form.dueAt}T00:00:00Z` : null,
      };
      if (form.taskId && !payload.assignee) delete payload.assignee;
      const task = form.taskId
        ? await taskService.updateNodeTask(workspaceSlug, chainId, nodeId, form.taskId, payload)
        : await taskService.createNodeTask(workspaceSlug, chainId, nodeId, payload);
      upsertTask(task);
      setFormOpen(false);
      setForm(EMPTY_FORM);
    } catch (error) {
      setFormError(serverErrorMessage(error, t("research.chain_tasks.server_rejected")));
    } finally {
      setFormBusy(false);
    }
  };

  /**
   * Run a no-reason lifecycle action and merge the returned task.
   *
   * Args:
   *   task: Target task.
   *   action: Server lifecycle action.
   */
  const runAction = async (task: TResearchChainNodeTask, action: "submit" | "complete") => {
    const busyKey = `${task.id}:${action}`;
    setActionBusy(busyKey);
    setActionError("");
    try {
      const updated = await taskService.runNodeTaskAction(workspaceSlug, chainId, nodeId, task.id, action);
      upsertTask(updated);
    } catch (error) {
      setActionError(serverErrorMessage(error, t("research.chain_tasks.server_rejected")));
    } finally {
      setActionBusy("");
    }
  };

  /** Validate and submit a return/cancel reason to the task action endpoint. */
  const submitReasonAction = async () => {
    if (!reasonAction?.reason.trim()) {
      setActionError(t("research.chain_tasks.reason_required"));
      return;
    }
    const busyKey = `${reasonAction.taskId}:${reasonAction.action}`;
    setActionBusy(busyKey);
    setActionError("");
    try {
      const updated = await taskService.runNodeTaskAction(
        workspaceSlug,
        chainId,
        nodeId,
        reasonAction.taskId,
        reasonAction.action,
        { reason: reasonAction.reason.trim() }
      );
      upsertTask(
        reasonAction.action === "return" ? { ...updated, return_reason: reasonAction.reason.trim() } : updated
      );
      setReasonAction(null);
    } catch (error) {
      setActionError(serverErrorMessage(error, t("research.chain_tasks.server_rejected")));
    } finally {
      setActionBusy("");
    }
  };

  const activeReasonAction = reasonAction;

  return (
    <section className="p-5" aria-label={t("research.chain_tasks.panel_title")}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-15 font-semibold text-primary">{t("research.chain_tasks.panel_title")}</h3>
          <p className="mt-1 text-12 text-secondary">{t("research.chain_tasks.panel_hint")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" disabled={state === "loading"} onClick={() => void load()}>
            {t("research.chain_tasks.refresh")}
          </Button>
          {state === "ready" && candidateState === "ready" && (
            <Button variant="primary" size="sm" onClick={startCreate}>
              {t("research.chain_tasks.create")}
            </Button>
          )}
        </div>
      </header>

      <div className="mt-4 border-t border-subtle pt-4">
        {state === "loading" && (
          <p className="text-12 text-tertiary" role="status">
            {t("research.chain_tasks.loading")}
          </p>
        )}
        {state === "forbidden" && (
          <p className="text-12 text-primary" role="alert">
            {t("research.chain_tasks.no_permission")}
          </p>
        )}
        {state === "error" && (
          <p className="text-12 text-danger-primary" role="alert">
            {t("research.chain_tasks.load_failed")}
          </p>
        )}

        {state === "ready" && candidateState === "forbidden" && (
          <p className="text-12 text-secondary" role="status">
            {t("research.chain_tasks.candidate_no_permission")}
          </p>
        )}
        {state === "ready" && candidateState === "error" && (
          <p className="text-12 text-secondary" role="status">
            {t("research.chain_tasks.candidate_load_failed")}
          </p>
        )}

        {state === "ready" && (
          <>
            {formOpen && (
              <form
                className="mb-5 grid grid-cols-1 gap-3 rounded-lg border border-subtle bg-surface-1 p-4 md:grid-cols-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitForm();
                }}
              >
                <label className="flex min-w-0 flex-col gap-1 text-11 text-tertiary">
                  <span>{t("research.chain_tasks.title")}</span>
                  <input
                    value={form.title}
                    onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                    className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary"
                  />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-11 text-tertiary">
                  <span>{t("research.chain_tasks.due_at")}</span>
                  <input
                    type="date"
                    value={form.dueAt}
                    onChange={(event) => setForm((current) => ({ ...current, dueAt: event.target.value }))}
                    className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary"
                  />
                </label>
                <ResearchAssigneeSelect
                  candidates={candidates}
                  value={form.assignee}
                  label={t("research.chain_tasks.assignee")}
                  disabled={formBusy || candidateState !== "ready"}
                  onChange={(userId) => setForm((current) => ({ ...current, assignee: userId }))}
                />
                <label className="flex min-w-0 flex-col gap-1 text-11 text-tertiary md:col-span-2">
                  <span>{t("research.chain_tasks.instruction")}</span>
                  <textarea
                    value={form.instruction}
                    rows={3}
                    onChange={(event) => setForm((current) => ({ ...current, instruction: event.target.value }))}
                    className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary"
                  />
                </label>
                <div className="flex items-center gap-2 md:col-span-2">
                  <Button variant="primary" size="sm" disabled={formBusy} onClick={() => void submitForm()}>
                    {formBusy
                      ? t("research.chain_tasks.saving")
                      : form.taskId
                        ? t("research.chain_tasks.save")
                        : t("research.chain_tasks.create")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={formBusy}
                    onClick={() => {
                      setFormOpen(false);
                      setFormError("");
                    }}
                  >
                    {t("research.chain_tasks.cancel_edit")}
                  </Button>
                </div>
                {formError && (
                  <p className="text-12 text-danger-primary md:col-span-2" role="alert">
                    {formError}
                  </p>
                )}
              </form>
            )}

            {!tasks.length && (
              <p className="text-12 text-tertiary" role="status">
                {t("research.chain_tasks.empty")}
              </p>
            )}

            <ul className="divide-y divide-subtle" role="list">
              {tasks.map((task) => (
                <li key={task.id} className="py-4 first:pt-0 last:pb-0">
                  <article>
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                      <div className="min-w-0">
                        <h4 className="text-13 font-medium text-primary">{task.title}</h4>
                        <p className="mt-1 text-12 text-secondary">{task.instruction || "—"}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <ResearchStatusBadge status={task.status} size="sm">
                          {t(TASK_STATUS_KEYS[task.status])}
                        </ResearchStatusBadge>
                        <span className="text-11 text-tertiary">{task.status}</span>
                      </div>
                    </div>

                    <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-12 sm:grid-cols-2 xl:grid-cols-3">
                      <div className="min-w-0">
                        <dt className="text-11 text-tertiary">{t("research.chain_tasks.assigned_by")}</dt>
                        <dd className="truncate text-secondary">{userName(task.assigned_by_detail ?? null)}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-11 text-tertiary">{t("research.chain_tasks.assignee")}</dt>
                        <dd className="truncate text-secondary">{userName(task.assignee_detail ?? null)}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-11 text-tertiary">{t("research.chain_tasks.due_at")}</dt>
                        <dd className="truncate text-secondary">
                          {formatResearchDate(task.due_at, currentLocale) || "—"}
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-11 text-tertiary">{t("research.chain_tasks.submitted_at")}</dt>
                        <dd className="truncate text-secondary">
                          {formatResearchDateTime(task.submitted_at, currentLocale) || "—"}
                        </dd>
                      </div>
                      <div className="min-w-0 sm:col-span-2 xl:col-span-2">
                        <dt className="text-11 text-tertiary">{t("research.chain_tasks.return_reason")}</dt>
                        <dd className="text-secondary">{task.return_reason || "—"}</dd>
                      </div>
                    </dl>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {isTaskActionAllowed(task, "edit") && (
                        <Button variant="secondary" size="sm" onClick={() => startEdit(task)}>
                          {t("research.chain_tasks.edit")}
                        </Button>
                      )}
                      {isTaskActionAllowed(task, "assign") && (
                        <Button variant="secondary" size="sm" onClick={() => startEdit(task)}>
                          {t("research.chain_tasks.assign")}
                        </Button>
                      )}
                      {isTaskActionAllowed(task, "submit") && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={actionBusy === `${task.id}:submit`}
                          onClick={() => void runAction(task, "submit")}
                        >
                          {actionBusy === `${task.id}:submit`
                            ? t("research.chain_tasks.processing")
                            : t("research.chain_tasks.submit")}
                        </Button>
                      )}
                      {isTaskActionAllowed(task, "return") && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={Boolean(actionBusy)}
                          onClick={() => setReasonAction({ taskId: task.id, action: "return", reason: "" })}
                        >
                          {t("research.chain_tasks.return")}
                        </Button>
                      )}
                      {isTaskActionAllowed(task, "complete") && (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={actionBusy === `${task.id}:complete`}
                          onClick={() => void runAction(task, "complete")}
                        >
                          {actionBusy === `${task.id}:complete`
                            ? t("research.chain_tasks.processing")
                            : t("research.chain_tasks.complete")}
                        </Button>
                      )}
                      {isTaskActionAllowed(task, "cancel") && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={Boolean(actionBusy)}
                          onClick={() => setReasonAction({ taskId: task.id, action: "cancel", reason: "" })}
                        >
                          {t("research.chain_tasks.cancel")}
                        </Button>
                      )}
                    </div>

                    {activeReasonAction && (
                      <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_auto_auto]">
                        <label className="flex min-w-0 flex-col gap-1 text-11 text-tertiary">
                          <span>
                            {activeReasonAction.action === "return"
                              ? t("research.chain_tasks.return_reason")
                              : t("research.chain_tasks.cancel_reason")}
                          </span>
                          <textarea
                            value={activeReasonAction.reason}
                            rows={2}
                            onChange={(event) =>
                              setReasonAction((current) =>
                                current ? { ...current, reason: event.target.value } : current
                              )
                            }
                            className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary"
                          />
                        </label>
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={actionBusy === `${task.id}:${activeReasonAction.action}`}
                          onClick={() => void submitReasonAction()}
                        >
                          {actionBusy === `${task.id}:${activeReasonAction.action}`
                            ? t("research.chain_tasks.processing")
                            : t("research.chain_tasks.confirm")}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={Boolean(actionBusy)}
                          onClick={() => setReasonAction(null)}
                        >
                          {t("research.chain_tasks.cancel_edit")}
                        </Button>
                      </div>
                    )}
                  </article>
                </li>
              ))}
            </ul>
          </>
        )}

        {actionError && state !== "forbidden" && (
          <p className="mt-3 text-12 text-danger-primary" role="alert">
            {actionError}
          </p>
        )}
      </div>
    </section>
  );
}
