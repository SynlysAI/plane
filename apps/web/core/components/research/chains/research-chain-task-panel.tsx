"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type {
  TResearchAssignableUser,
  TResearchChainNodeTask,
  TResearchChainNodeTaskAction,
  TResearchChainNodeTaskCreatePayload,
  TResearchChainNodeTaskUpdatePayload,
  TResearchTaskInstructionAttachment,
} from "@plane/types";
import { formatResearchDate } from "@/components/research/common/research-format";
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import { ResearchTodoUrgency } from "@/components/research/common/research-todo-urgency";
import { ResearchAssigneeSelect } from "@/components/research/chains/research-assignee-select";
import { ResearchChainTaskPeek } from "@/components/research/chains/research-chain-task-peek";
import {
  useResearchChainWorkbenchPeek,
  type TWorkbenchPeekMode,
} from "@/components/research/chains/research-chain-workbench-peek";
import { useTransientMenu } from "@/hooks/use-transient-menu";
import { ResearchChainTaskService, type TResearchChainTaskAction } from "@/services/research/chain-task.service";

type Props = {
  workspaceSlug: string;
  chainId: string;
  nodeId: string;
  /** 首页动态等外部链接指定的一次性任务深链 ID。 */
  initialTaskId?: string | null;
};

type TPanelState = "loading" | "ready" | "forbidden" | "error";
type TCandidateState = "loading" | "ready" | "forbidden" | "error";
type TLocalPeek = { kind: "task"; taskId: string } | { kind: "create" } | null;

type TTaskFormState = {
  taskId: string | null;
  title: string;
  instruction: string;
  assignee: string;
  dueAt: string;
};

type TReasonActionState = {
  taskId: string;
  action: Extract<TResearchChainNodeTaskAction, "cancel">;
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
  COMPLETED: "research.chain_tasks.status.completed",
  CANCELLED: "research.chain_tasks.status.cancelled",
};

const LIFECYCLE_ACTIONS = ["complete", "reopen", "cancel"] as const;

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
export function ResearchChainTaskPanel({ workspaceSlug, chainId, nodeId, initialTaskId }: Props) {
  const { t, currentLocale } = useTranslation();
  const taskService = useMemo(() => new ResearchChainTaskService(), []);
  const sharedPeek = useResearchChainWorkbenchPeek();
  const [tasks, setTasks] = useState<TResearchChainNodeTask[]>([]);
  const [candidates, setCandidates] = useState<TResearchAssignableUser[]>([]);
  const [state, setState] = useState<TPanelState>("loading");
  const [candidateState, setCandidateState] = useState<TCandidateState>("loading");
  const [localPeek, setLocalPeek] = useState<TLocalPeek>(null);
  const [quickAdd, setQuickAdd] = useState(false);
  const [quickTitle, setQuickTitle] = useState("");
  const [form, setForm] = useState<TTaskFormState>(EMPTY_FORM);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [reasonAction, setReasonAction] = useState<TReasonActionState | null>(null);
  const [actionBusy, setActionBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [statusMenuId, setStatusMenuId] = useState<string | null>(null);
  const [dateMenuId, setDateMenuId] = useState<string | null>(null);
  const statusMenuRef = useRef<HTMLDivElement | null>(null);
  const dateMenuRef = useRef<HTMLDivElement | null>(null);
  const [peekMode, setPeekMode] = useState<TWorkbenchPeekMode>("side");
  const [isTaskEditMode, setIsTaskEditMode] = useState(false);
  const handledInitialTaskIdRef = useRef<string | null>(null);
  const peek: TLocalPeek = sharedPeek
    ? sharedPeek.peek?.kind === "task" || sharedPeek.peek?.kind === "create"
      ? sharedPeek.peek
      : null
    : localPeek;
  const activeTask = peek?.kind === "task" ? (tasks.find((task) => task.id === peek.taskId) ?? null) : null;
  const peekKind = peek?.kind ?? "closed";
  const peekTaskId = peek?.kind === "task" ? peek.taskId : null;
  const closeStatusMenu = useCallback(() => setStatusMenuId(null), []);
  const closeDateMenu = useCallback(() => setDateMenuId(null), []);
  const { handleKeyDown: handleStatusMenuKeyDown } = useTransientMenu({
    ref: statusMenuRef,
    isOpen: statusMenuId !== null,
    onClose: closeStatusMenu,
  });
  const { handleKeyDown: handleDateMenuKeyDown } = useTransientMenu({
    ref: dateMenuRef,
    isOpen: dateMenuId !== null,
    onClose: closeDateMenu,
  });

  // 共享 Peek 可能从其他入口切换任务或进入创建态，这里统一重置主内容编辑态。
  useEffect(() => {
    setIsTaskEditMode(peekKind === "create");
  }, [peekKind, peekTaskId]);

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
    setQuickAdd(false);
    setQuickTitle("");
    setForm(EMPTY_FORM);
    setLocalPeek(null);
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

  /**
   * 同步任务描述附件的即时上传结果，避免重新打开详情时读到旧列表。
   *
   * Args:
   *   taskId: 当前任务 ID。
   *   attachments: 服务端确认后的最新附件列表。
   */
  const updateTaskAttachments = useCallback((taskId: string, attachments: TResearchTaskInstructionAttachment[]) => {
    setTasks((current) =>
      current.map((task) => (task.id === taskId ? { ...task, instruction_attachments: attachments } : task))
    );
  }, []);

  const closePeek = () => {
    setIsTaskEditMode(false);
    if (sharedPeek) sharedPeek.close();
    else setLocalPeek(null);
  };

  const openTask = useCallback(
    (task: TResearchChainNodeTask) => {
      setForm({
        taskId: task.id,
        title: task.title,
        instruction: task.instruction,
        assignee: task.assignee ?? "",
        dueAt: toDateInput(task.due_at),
      });
      setFormError("");
      setStatusMenuId(null);
      setIsTaskEditMode(false);
      if (sharedPeek) sharedPeek.openTask(task.id);
      else setLocalPeek({ kind: "task", taskId: task.id });
    },
    [sharedPeek]
  );

  useEffect(() => {
    if (!initialTaskId || state !== "ready" || handledInitialTaskIdRef.current === initialTaskId) return;

    const task = tasks.find((item) => item.id === initialTaskId);
    if (!task) return;

    handledInitialTaskIdRef.current = initialTaskId;
    openTask(task);
  }, [initialTaskId, openTask, state, tasks]);

  const openCreate = (title = "") => {
    setForm({ ...EMPTY_FORM, title });
    setFormError("");
    setQuickAdd(false);
    setIsTaskEditMode(true);
    if (sharedPeek) sharedPeek.openCreate();
    else setLocalPeek({ kind: "create" });
  };

  /** Validate and submit the create or edit form. */
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
      closePeek();
      setForm(EMPTY_FORM);
      setQuickTitle("");
    } catch (error) {
      setFormError(serverErrorMessage(error, t("research.chain_tasks.server_rejected")));
    } finally {
      setFormBusy(false);
    }
  };

  /** Create a task from the inline title row. */
  const submitQuickAdd = async () => {
    if (!quickTitle.trim()) {
      setFormError(t("research.chain_tasks.title_required"));
      return;
    }
    setForm({ ...EMPTY_FORM, title: quickTitle });
    setFormBusy(true);
    setFormError("");
    try {
      const task = await taskService.createNodeTask(workspaceSlug, chainId, nodeId, {
        title: quickTitle.trim(),
        instruction: "",
        assignee: null,
        due_at: null,
      });
      upsertTask(task);
      setQuickAdd(false);
      setQuickTitle("");
    } catch (error) {
      setFormError(serverErrorMessage(error, t("research.chain_tasks.server_rejected")));
    } finally {
      setFormBusy(false);
    }
  };

  /**
   * 保存详情里改过的字段，并保持 Peek 打开。
   *
   * Args:
   *   task: 当前打开的任务。
   *   payload: 任务更新接口接受的局部字段。
   */
  const savePeekFields = async (
    task: TResearchChainNodeTask,
    payload: TResearchChainNodeTaskUpdatePayload
  ): Promise<boolean> => {
    if (task.assignee && payload.assignee === null) {
      setFormError(t("research.chain_tasks.assignee_required"));
      return false;
    }
    setFormBusy(true);
    setFormError("");
    try {
      const updated = await taskService.updateNodeTask(workspaceSlug, chainId, nodeId, task.id, payload);
      upsertTask(updated);
      setForm((current) => ({
        ...current,
        title: payload.title !== undefined ? updated.title : current.title,
        instruction: payload.instruction !== undefined ? updated.instruction : current.instruction,
        assignee: payload.assignee !== undefined ? (updated.assignee ?? "") : current.assignee,
        dueAt: payload.due_at !== undefined ? toDateInput(updated.due_at) : current.dueAt,
      }));
      return true;
    } catch (error) {
      setFormError(serverErrorMessage(error, t("research.chain_tasks.server_rejected")));
      return false;
    } finally {
      setFormBusy(false);
    }
  };

  /**
   * 切换主内容编辑态，并在退出编辑时批量保存文本变更。
   *
   * Args:
   *   next: 主内容是否进入编辑态。
   */
  const toggleTaskEditMode = (next: boolean) => {
    if (next) {
      setIsTaskEditMode(true);
      return;
    }
    if (peek?.kind !== "task" || !activeTask) {
      setIsTaskEditMode(false);
      return;
    }
    const title = form.title.trim();
    if (!title) {
      setFormError(t("research.chain_tasks.title_required"));
      return;
    }

    const payload: TResearchChainNodeTaskUpdatePayload = {};
    if (title !== activeTask.title) payload.title = title;
    if (form.instruction !== activeTask.instruction) payload.instruction = form.instruction;
    if (!Object.keys(payload).length) {
      setFormError("");
      setIsTaskEditMode(false);
      return;
    }

    void (async () => {
      const saved = await savePeekFields(activeTask, payload);
      if (saved) setIsTaskEditMode(false);
    })();
  };

  /**
   * Update one property without opening the full editor.
   *
   * Args:
   *   task: Task being edited from the row.
   *   payload: Partial update accepted by the existing task endpoint.
   */
  const updateProperty = async (task: TResearchChainNodeTask, payload: TResearchChainNodeTaskUpdatePayload) => {
    if (task.assignee && payload.assignee === null) {
      setActionError(t("research.chain_tasks.assignee_required"));
      return;
    }
    setActionBusy(`${task.id}:edit`);
    setActionError("");
    try {
      const updated = await taskService.updateNodeTask(workspaceSlug, chainId, nodeId, task.id, payload);
      upsertTask(updated);
    } catch (error) {
      setActionError(serverErrorMessage(error, t("research.chain_tasks.server_rejected")));
    } finally {
      setActionBusy("");
    }
  };

  /**
   * Run a no-reason lifecycle action and merge the returned task.
   *
   * Args:
   *   task: Target task.
   *   action: Server lifecycle action.
   */
  const runAction = async (task: TResearchChainNodeTask, action: Exclude<TResearchChainTaskAction, "cancel">) => {
    const busyKey = `${task.id}:${action}`;
    setActionBusy(busyKey);
    setActionError("");
    try {
      const updated = await taskService.runNodeTaskAction(workspaceSlug, chainId, nodeId, task.id, action);
      upsertTask(updated);
      setStatusMenuId(null);
    } catch (error) {
      setActionError(serverErrorMessage(error, t("research.chain_tasks.server_rejected")));
    } finally {
      setActionBusy("");
    }
  };

  /** Validate and submit a cancellation reason to the task action endpoint. */
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
      upsertTask(updated);
      setReasonAction(null);
      setStatusMenuId(null);
    } catch (error) {
      setActionError(serverErrorMessage(error, t("research.chain_tasks.server_rejected")));
    } finally {
      setActionBusy("");
    }
  };

  const canCreate = state === "ready" && candidateState === "ready";

  return (
    <section className="px-4 py-3" aria-label={t("research.chain_tasks.panel_title")}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h3 className="flex items-baseline gap-2 text-13 font-semibold text-primary">
          {t("research.chain_tasks.panel_title")}
          {state === "ready" && <span className="font-normal text-11 text-tertiary">{tasks.length}</span>}
        </h3>
        <Button variant="secondary" size="sm" disabled={state === "loading"} onClick={() => void load()}>
          {t("research.chain_tasks.refresh")}
        </Button>
      </header>

      <div className="mt-3 border-t border-subtle">
        {state === "loading" && (
          <p className="py-3 text-12 text-tertiary" role="status">
            {t("research.chain_tasks.loading")}
          </p>
        )}
        {state === "forbidden" && (
          <p className="py-3 text-12 text-primary" role="alert">
            {t("research.chain_tasks.no_permission")}
          </p>
        )}
        {state === "error" && (
          <p className="py-3 text-12 text-danger-primary" role="alert">
            {t("research.chain_tasks.load_failed")}
          </p>
        )}
        {state === "ready" && candidateState === "forbidden" && (
          <p className="py-2 text-12 text-secondary" role="status">
            {t("research.chain_tasks.candidate_no_permission")}
          </p>
        )}
        {state === "ready" && candidateState === "error" && (
          <p className="py-2 text-12 text-secondary" role="status">
            {t("research.chain_tasks.candidate_load_failed")}
          </p>
        )}

        {state === "ready" && (
          <>
            {!tasks.length && (
              <p className="py-3 text-12 text-tertiary" role="status">
                {t("research.chain_tasks.empty")}
              </p>
            )}
            <ul role="list">
              {tasks.map((task) => {
                const canEdit = isTaskActionAllowed(task, "edit");
                const canAssign = canEdit || isTaskActionAllowed(task, "assign");
                const lifecycle = LIFECYCLE_ACTIONS.filter((action) => isTaskActionAllowed(task, action));
                const peeked = peek?.kind === "task" && peek.taskId === task.id;
                return (
                  <li key={task.id} className="border-b border-subtle" data-task-row={task.id} data-peek-trigger="">
                    <div
                      className={`flex min-h-9 items-center gap-2 border-l-2 px-1 ${
                        peeked ? "border-accent-primary bg-surface-2" : "border-transparent hover:bg-surface-2"
                      }`}
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate px-1 text-left text-13 text-primary"
                        onClick={() => openTask(task)}
                      >
                        {task.title}
                      </button>
                      <span className="sr-only">{task.status}</span>
                      <div className="flex shrink-0 items-center gap-1">
                        <ResearchAssigneeSelect
                          candidates={candidates}
                          value={task.assignee ?? ""}
                          selectedLabel={task.assignee_detail?.display_name}
                          label={t("research.chain_tasks.assignee")}
                          disabled={!canAssign || candidateState !== "ready" || Boolean(actionBusy)}
                          allowClear={!task.assignee}
                          onChange={(userId) => void updateProperty(task, { assignee: userId || null })}
                        />
                        {canEdit ? (
                          <div
                            role="presentation"
                            className="relative"
                            data-task-menu=""
                            ref={dateMenuId === task.id ? dateMenuRef : undefined}
                            onKeyDown={handleDateMenuKeyDown}
                          >
                            <button
                              type="button"
                              aria-label={t("research.chain_tasks.due_at")}
                              aria-expanded={dateMenuId === task.id}
                              aria-haspopup="dialog"
                              className="h-7 rounded-sm px-1.5 text-12 text-secondary hover:bg-surface-2"
                              onClick={() => {
                                setStatusMenuId(null);
                                setDateMenuId((current) => (current === task.id ? null : task.id));
                              }}
                            >
                              {formatResearchDate(task.due_at, currentLocale) || "—"}
                              {task.due_at && <ResearchTodoUrgency dueAt={task.due_at} />}
                            </button>
                            {dateMenuId === task.id && (
                              <div
                                role="dialog"
                                aria-label={t("research.chain_tasks.due_at")}
                                className="absolute top-8 right-0 z-20 rounded-md border border-subtle bg-surface-1 p-2 shadow-[0_8px_24px_rgba(37,37,34,0.08)]"
                              >
                                <input
                                  type="date"
                                  aria-label={t("research.chain_tasks.due_at")}
                                  defaultValue={toDateInput(task.due_at)}
                                  onChange={(event) => {
                                    void updateProperty(task, {
                                      due_at: event.target.value ? `${event.target.value}T00:00:00Z` : null,
                                    });
                                    setDateMenuId(null);
                                  }}
                                  className="rounded-md border border-subtle bg-surface-1 px-2 py-1 text-12 text-primary"
                                />
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="px-1.5 text-12 text-secondary">
                            {formatResearchDate(task.due_at, currentLocale) || "—"}
                          </span>
                        )}
                        <div
                          role="presentation"
                          className="relative"
                          data-task-menu=""
                          ref={statusMenuId === task.id ? statusMenuRef : undefined}
                          onKeyDown={handleStatusMenuKeyDown}
                        >
                          {lifecycle.length ? (
                            <button
                              type="button"
                              aria-label={t("common.state")}
                              aria-expanded={statusMenuId === task.id}
                              aria-haspopup="menu"
                              className="h-7 rounded-sm px-1"
                              onClick={() => {
                                setDateMenuId(null);
                                setStatusMenuId((current) => (current === task.id ? null : task.id));
                              }}
                            >
                              <ResearchStatusBadge status={task.status} size="sm">
                                {t(TASK_STATUS_KEYS[task.status])}
                              </ResearchStatusBadge>
                            </button>
                          ) : (
                            <ResearchStatusBadge status={task.status} size="sm">
                              {t(TASK_STATUS_KEYS[task.status])}
                            </ResearchStatusBadge>
                          )}
                          {statusMenuId === task.id && (
                            <div
                              role="menu"
                              className="absolute top-8 right-0 z-20 min-w-28 rounded-md border border-subtle bg-surface-1 p-1 shadow-[0_8px_24px_rgba(37,37,34,0.08)]"
                            >
                              {lifecycle.map((action) => (
                                <button
                                  key={action}
                                  type="button"
                                  role="menuitem"
                                  className="block w-full rounded-sm px-2 py-1.5 text-left text-12 text-primary hover:bg-surface-2"
                                  onClick={() => {
                                    if (action === "cancel") {
                                      setReasonAction({ taskId: task.id, action, reason: "" });
                                      setActionError("");
                                      closeStatusMenu();
                                      return;
                                    }
                                    closeStatusMenu();
                                    void runAction(task, action);
                                  }}
                                >
                                  {t(`research.chain_tasks.${action}`)}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            {canCreate &&
              (quickAdd ? (
                <form
                  className="flex flex-wrap items-center gap-2 py-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitQuickAdd();
                  }}
                >
                  <input
                    aria-label={t("research.chain_tasks.title")}
                    value={quickTitle}
                    onChange={(event) => setQuickTitle(event.target.value)}
                    className="min-w-0 flex-1 rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary"
                  />
                  <Button variant="primary" size="sm" disabled={formBusy} onClick={() => void submitQuickAdd()}>
                    {t("research.chain_tasks.create")}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => openCreate(quickTitle)}>
                    {t("research.chain_tasks.more")}
                  </Button>
                </form>
              ) : (
                <button
                  type="button"
                  className="py-2 text-13 text-secondary hover:text-primary"
                  onClick={() => {
                    setQuickAdd(true);
                    setFormError("");
                  }}
                >
                  + {t("research.chain_tasks.create")}
                </button>
              ))}
            {formError && !peek && (
              <p className="pb-2 text-12 text-danger-primary" role="alert">
                {formError}
              </p>
            )}
          </>
        )}
        {actionError && state !== "forbidden" && (
          <p className="py-2 text-12 text-danger-primary" role="alert">
            {actionError}
          </p>
        )}
      </div>

      {peek && (
        <ResearchChainTaskPeek
          kind={peek.kind}
          task={activeTask}
          form={form}
          formBusy={formBusy}
          formError={formError}
          isEditMode={peek.kind === "create" || (peek.kind === "task" && isTaskEditMode)}
          onToggleEditMode={toggleTaskEditMode}
          candidates={candidates}
          candidateState={candidateState}
          locale={currentLocale}
          mode={peekMode}
          workspaceSlug={workspaceSlug}
          nodeId={nodeId}
          actionBusy={actionBusy}
          onModeChange={setPeekMode}
          onClose={closePeek}
          onFormChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
          onTaskAttachmentsChange={updateTaskAttachments}
          onCommit={(payload) => {
            if (activeTask) void savePeekFields(activeTask, payload);
          }}
          onCreate={() => void submitForm()}
          onAction={(action) => {
            if (!activeTask) return;
            if (action === "cancel") {
              setReasonAction({ taskId: activeTask.id, action, reason: "" });
              setActionError("");
              return;
            }
            void runAction(activeTask, action);
          }}
        />
      )}

      {reasonAction && (
        <div
          role="dialog"
          data-reason-dialog=""
          aria-label={t("research.chain_tasks.cancel_reason")}
          className="fixed top-24 right-6 z-40 w-80 rounded-md border border-subtle bg-surface-1 p-4 shadow-[0_8px_24px_rgba(37,37,34,0.08)]"
        >
          <label className="flex flex-col gap-1 text-11 text-tertiary">
            <span>{t("research.chain_tasks.cancel_reason")}</span>
            <textarea
              value={reasonAction.reason}
              rows={3}
              onChange={(event) =>
                setReasonAction((current) => (current ? { ...current, reason: event.target.value } : current))
              }
              className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary"
            />
          </label>
          <div className="mt-3 flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={Boolean(actionBusy)}
              onClick={() => void submitReasonAction()}
            >
              {actionBusy ? t("research.chain_tasks.processing") : t("research.chain_tasks.confirm")}
            </Button>
            <Button variant="secondary" size="sm" disabled={Boolean(actionBusy)} onClick={() => setReasonAction(null)}>
              {t("research.chain_tasks.cancel_edit")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
