"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ActivityOutline,
  ArrowNarrowRightOutline,
  CheckDoneOutline,
  ClockOutline,
  CloseOutline,
  CompletedAtOutline,
  CreatedAtOutline,
  DueDateOutline,
  FileOutline,
  FullScreenPeekOutline,
  MembersOutline,
  ModalPeekOutline,
  MoreHorizontalOutline,
  ReplyOutline,
  SendOutline,
  SidePeekOutline,
  SortAscendingOutline,
  SortDescendingOutline,
  StateOutline,
  UpdatedAtOutline,
  UserOutline,
} from "@makeplane/propel/icons";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type {
  TResearchAssignableUser,
  TResearchChainEvent,
  TResearchChainNodeTask,
  TResearchChainNodeTaskAction,
  TResearchChainNodeTaskResourceType,
  TResearchChainNodeTaskUpdatePayload,
} from "@plane/types";
import { cn } from "@plane/utils";
import { formatResearchDate, formatResearchDateTime } from "@/components/research/common/research-format";
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import { ResearchTodoUrgency } from "@/components/research/common/research-todo-urgency";
import { ResearchAssigneeSelect } from "@/components/research/chains/research-assignee-select";
import {
  ResearchChainWorkbenchPeek,
  type TWorkbenchPeekMode,
} from "@/components/research/chains/research-chain-workbench-peek";
import { ResearchChainTaskService } from "@/services/research/chain-task.service";

type TTaskFormState = {
  taskId: string | null;
  title: string;
  instruction: string;
  assignee: string;
  dueAt: string;
};

type TCandidateState = "loading" | "ready" | "forbidden" | "error";
type TLifecycleAction = Extract<TResearchChainNodeTaskAction, "submit" | "return" | "complete" | "cancel">;
type TActivityOrder = "asc" | "desc";

type TActivityItem = {
  id: string;
  actor: string;
  verb: string;
  at: string;
  detail?: string;
};

type Props = {
  kind: "create" | "task";
  task: TResearchChainNodeTask | null;
  form: TTaskFormState;
  formBusy: boolean;
  formError: string;
  candidates: TResearchAssignableUser[];
  candidateState: TCandidateState;
  locale: string;
  mode: TWorkbenchPeekMode;
  workspaceSlug: string;
  nodeId: string;
  actionBusy: string;
  onModeChange: (mode: TWorkbenchPeekMode) => void;
  onClose: () => void;
  onFormChange: (patch: Partial<TTaskFormState>) => void;
  onCommit: (payload: TResearchChainNodeTaskUpdatePayload) => void;
  onCreate: () => void;
  onAction: (action: TLifecycleAction) => void;
};

const LIFECYCLE_ACTIONS: TLifecycleAction[] = ["submit", "return", "complete", "cancel"];

const STATUS_KEYS: Record<TResearchChainNodeTask["status"], string> = {
  DRAFT: "research.chain_tasks.status.draft",
  ASSIGNED: "research.chain_tasks.status.assigned",
  SUBMITTED: "research.chain_tasks.status.submitted",
  NEEDS_REVISION: "research.chain_tasks.status.needs_revision",
  COMPLETED: "research.chain_tasks.status.completed",
  CANCELLED: "research.chain_tasks.status.cancelled",
};

const EVENT_KEYS: Record<string, string> = {
  TASK_CREATED: "research.chain_tasks.events.created",
  TASK_ASSIGNED: "research.chain_tasks.events.assigned",
  TASK_SUBMITTED: "research.chain_tasks.events.submitted",
  TASK_RETURNED: "research.chain_tasks.events.returned",
  TASK_COMPLETED: "research.chain_tasks.events.completed",
  TASK_CANCELLED: "research.chain_tasks.events.cancelled",
};

const PEEK_MODES: { key: TWorkbenchPeekMode; icon: typeof SidePeekOutline; label: string }[] = [
  { key: "side", icon: SidePeekOutline, label: "research.chain_tasks.peek_side" },
  { key: "modal", icon: ModalPeekOutline, label: "research.chain_tasks.peek_modal" },
  { key: "full", icon: FullScreenPeekOutline, label: "research.chain_tasks.peek_full" },
];

const ACTION_ICONS = {
  submit: SendOutline,
  return: ReplyOutline,
  complete: CheckDoneOutline,
  cancel: CloseOutline,
} as const;

/**
 * 判断服务端是否明确允许某个任务动作。
 *
 * Args:
 *   task: 带能力表的任务。
 *   action: 要检查的动作。
 *
 * Returns:
 *   仅当后端标记 allowed 时为 true。
 */
function isAllowed(task: TResearchChainNodeTask | null, action: TResearchChainNodeTaskAction) {
  return task?.capabilities?.actions[action]?.allowed === true;
}

/**
 * 把截止日期裁成 date input 接受的日期。
 *
 * Args:
 *   value: 后端 ISO 时间或空值。
 *
 * Returns:
 *   yyyy-mm-dd，没有截止日期时为空字符串。
 */
function toDateInput(value: string | null | undefined) {
  return value ? value.slice(0, 10) : "";
}

/**
 * 读取紧凑用户投影的显示名。
 *
 * Args:
 *   user: 责任人或指派人投影。
 *
 * Returns:
 *   显示名；缺失时为空字符串，由调用方决定占位。
 */
function userName(user: { display_name?: string } | null | undefined) {
  return user?.display_name || "";
}

/**
 * 判断 Chain Event 是否指向当前任务。
 *
 * Args:
 *   event: 节点时间线上的不可变事件。
 *   taskId: 当前打开的任务 id。
 *
 * Returns:
 *   refs 中存在 kind=task 且 id 匹配时为 true。
 */
function eventMatchesTask(event: TResearchChainEvent, taskId: string) {
  return event.refs?.some((reference) => reference.kind === "task" && reference.id === taskId) === true;
}

/**
 * 把事件里的 actor id 解析成已有的显示名。
 *
 * Args:
 *   actorId: Chain Event 上的用户 id。
 *   task: 当前任务，携带责任人和指派人投影。
 *   candidates: 可指派候选人。
 *
 * Returns:
 *   能解析到的显示名，否则为空字符串。
 */
function actorName(actorId: string | null, task: TResearchChainNodeTask, candidates: TResearchAssignableUser[]) {
  if (!actorId) return "";
  if (task.assignee_detail?.id === actorId) return task.assignee_detail.display_name;
  if (task.assigned_by_detail?.id === actorId) return task.assigned_by_detail.display_name;
  return candidates.find((candidate) => candidate.user_id === actorId)?.display_name || "";
}

/**
 * 在没有 Chain Event 时，用任务时间戳拼一条可读活动。
 *
 * Args:
 *   task: 当前任务。
 *   t: 翻译函数。
 *
 * Returns:
 *   按发生时间可排序的活动条目。
 */
function synthesizedActivity(task: TResearchChainNodeTask, t: (key: string) => string): TActivityItem[] {
  const items: TActivityItem[] = [];
  if (task.created_at) {
    items.push({
      id: "created",
      actor: "",
      verb: t("research.chain_tasks.events.created"),
      at: task.created_at,
    });
  }
  if (task.assignee && task.assigned_by_detail && task.created_at) {
    items.push({
      id: "assigned",
      actor: task.assigned_by_detail.display_name,
      verb: t("research.chain_tasks.events.assigned"),
      at: task.created_at,
    });
  }
  if (task.submitted_at) {
    items.push({
      id: "submitted",
      actor: userName(task.assignee_detail),
      verb: t("research.chain_tasks.events.submitted"),
      at: task.submitted_at,
    });
  }
  if (task.return_reason) {
    items.push({
      id: "returned",
      actor: userName(task.assigned_by_detail),
      verb: t("research.chain_tasks.events.returned"),
      at: task.updated_at || task.submitted_at || task.created_at,
      detail: task.return_reason,
    });
  }
  if (task.completed_at) {
    items.push({
      id: "completed",
      actor: userName(task.assigned_by_detail),
      verb: t("research.chain_tasks.events.completed"),
      at: task.completed_at,
    });
  }
  if (task.status === "CANCELLED") {
    items.push({
      id: "cancelled",
      actor: userName(task.assigned_by_detail),
      verb: t("research.chain_tasks.events.cancelled"),
      at: task.updated_at || task.created_at,
    });
  }
  return items;
}

/**
 * 把匹配到的 Chain Event 转成活动行。
 *
 * Args:
 *   events: 已过滤到当前任务的事件。
 *   task: 当前任务，用于补显示名和退回原因。
 *   candidates: 可指派候选人。
 *   t: 翻译函数。
 *
 * Returns:
 *   活动条目；未知事件类型回退到摘要。
 */
function eventActivity(
  events: TResearchChainEvent[],
  task: TResearchChainNodeTask,
  candidates: TResearchAssignableUser[],
  t: (key: string) => string
): TActivityItem[] {
  return events.map((event) => ({
    id: event.event_id,
    actor: actorName(event.actor, task, candidates),
    verb: EVENT_KEYS[event.event_type] ? t(EVENT_KEYS[event.event_type]) : event.summary || event.event_type,
    at: event.occurred_at,
    detail: event.event_type === "TASK_RETURNED" ? task.return_reason || undefined : undefined,
  }));
}

/**
 * 科研任务详情。布局、尺寸和编辑方式对齐行政工作项 Peek，字段只保留任务契约里真实存在的内容。
 */
export function ResearchChainTaskPeek(props: Props) {
  const {
    kind,
    task,
    form,
    formBusy,
    formError,
    candidates,
    candidateState,
    locale,
    mode,
    workspaceSlug,
    nodeId,
    actionBusy,
    onModeChange,
    onClose,
    onFormChange,
    onCommit,
    onCreate,
    onAction,
  } = props;
  const { t } = useTranslation();
  const taskService = useMemo(() => new ResearchChainTaskService(), []);
  const [editingInstruction, setEditingInstruction] = useState(false);
  const [activityOrder, setActivityOrder] = useState<TActivityOrder>("asc");
  const [events, setEvents] = useState<TResearchChainEvent[]>([]);
  const canEdit = kind === "create" || isAllowed(task, "edit");
  const canAssign = kind === "create" || isAllowed(task, "edit") || isAllowed(task, "assign");
  const lifecycle = task ? LIFECYCLE_ACTIONS.filter((action) => isAllowed(task, action)) : [];
  const status = task?.status ?? "DRAFT";
  const title =
    kind === "create" ? t("research.chain_tasks.create") : task?.title || t("research.chain_tasks.panel_title");
  const dueValue = kind === "create" ? form.dueAt : task?.due_at || "";
  const assigneeValue = kind === "create" ? form.assignee : task?.assignee || "";

  useEffect(() => {
    if (kind !== "task" || !task) {
      setEvents([]);
      return;
    }
    const loader = (taskService as { getNodeEvents?: ResearchChainTaskService["getNodeEvents"] }).getNodeEvents;
    if (typeof loader !== "function") return;
    let active = true;
    void loader
      .call(taskService, workspaceSlug, nodeId)
      .then((loaded) => {
        if (active) setEvents(loaded.filter((event) => eventMatchesTask(event, task.id)));
        return null;
      })
      .catch(() => {
        if (active) setEvents([]);
        return null;
      });
    return () => {
      active = false;
    };
  }, [kind, nodeId, task, taskService, workspaceSlug]);

  const activity = useMemo(() => {
    if (!task) return [];
    const matched = events.length ? eventActivity(events, task, candidates, t) : synthesizedActivity(task, t);
    const sorted = [...matched].toSorted((left, right) => left.at.localeCompare(right.at));
    return activityOrder === "asc" ? sorted : sorted.toReversed();
  }, [activityOrder, candidates, events, t, task]);

  /**
   * 失焦后保存已有任务的标题或说明。新建任务只留在本地表单。
   */
  const commitText = (field: "title" | "instruction", value: string) => {
    if (kind !== "task" || !task || !canEdit) return;
    const next = value.trim();
    if (field === "title" && !next) {
      onFormChange({ title: task.title });
      return;
    }
    if (next === (field === "title" ? task.title : task.instruction)) return;
    onCommit(field === "title" ? { title: next } : { instruction: next });
  };

  return (
    <ResearchChainWorkbenchPeek
      title={title}
      onClose={onClose}
      size="wide"
      mode={mode}
      header={
        <TaskPeekHeader
          mode={mode}
          formBusy={formBusy}
          lifecycle={lifecycle}
          actionBusy={actionBusy}
          onModeChange={onModeChange}
          onClose={onClose}
          onAction={onAction}
        />
      }
      bodyClassName="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="flex flex-col gap-6 px-8 py-5">
        <div className="space-y-2">
          <p className="text-12 text-tertiary">
            {kind === "create" ? t("research.chain_tasks.panel_title") : t(STATUS_KEYS[status])}
          </p>
          {canEdit ? (
            <input
              aria-label={t("research.chain_tasks.title")}
              value={form.title}
              placeholder={t("research.chain_tasks.title")}
              onChange={(event) => onFormChange({ title: event.target.value })}
              onBlur={(event) => commitText("title", event.target.value)}
              className="w-full border-0 bg-transparent p-0 text-20 font-medium text-primary outline-none placeholder:text-placeholder"
            />
          ) : (
            <h2 className="text-20 font-medium text-primary">{task?.title}</h2>
          )}
          <InstructionField
            value={form.instruction}
            canEdit={canEdit}
            editing={editingInstruction}
            onEdit={() => setEditingInstruction(true)}
            onChange={(instruction) => onFormChange({ instruction })}
            onBlur={(value) => {
              setEditingInstruction(false);
              commitText("instruction", value);
            }}
          />
        </div>

        {lifecycle.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {lifecycle.map((action) => {
              const Icon = ACTION_ICONS[action];
              return (
                <button
                  key={action}
                  type="button"
                  disabled={Boolean(actionBusy)}
                  onClick={() => onAction(action)}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-strong bg-layer-2 px-2 text-12 text-secondary hover:bg-layer-2-hover disabled:text-placeholder"
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t(`research.chain_tasks.${action}`)}
                </button>
              );
            })}
          </div>
        )}

        <section>
          <h3 className="text-12 font-medium text-primary">{t("research.chain_tasks.properties")}</h3>
          <div className={`mt-3 space-y-3 ${canEdit || canAssign ? "" : "opacity-80"}`}>
            <PropertyRow icon={StateOutline} label={t("common.state")}>
              <StatusControl
                status={status}
                label={t(STATUS_KEYS[status])}
                actions={lifecycle}
                disabled={Boolean(actionBusy)}
                onAction={onAction}
              />
            </PropertyRow>
            <PropertyRow icon={MembersOutline} label={t("research.chain_tasks.assignee")}>
              {canAssign && candidateState === "ready" ? (
                <ResearchAssigneeSelect
                  candidates={candidates}
                  value={assigneeValue}
                  label={t("research.chain_tasks.assignee")}
                  placeholder={t("research.chain_tasks.add_assignee")}
                  fullWidth
                  menuAlign="left"
                  allowClear={kind === "create" || !task?.assignee}
                  onChange={(userId) => {
                    if (kind === "create") onFormChange({ assignee: userId });
                    else onCommit({ assignee: userId || null });
                  }}
                />
              ) : (
                <span className="px-2 text-12 text-primary">{userName(task?.assignee_detail) || "—"}</span>
              )}
            </PropertyRow>
            {task && (
              <PropertyRow icon={UserOutline} label={t("research.chain_tasks.assigned_by")}>
                <ReadOnlyValue value={userName(task.assigned_by_detail)} />
              </PropertyRow>
            )}
            <PropertyRow icon={DueDateOutline} label={t("research.chain_tasks.due_at")}>
              <DueDateControl
                value={dueValue}
                locale={locale}
                label={t("research.chain_tasks.due_at")}
                placeholder={t("research.chain_tasks.add_due_at")}
                disabled={!canEdit}
                onChange={(value) => {
                  if (kind === "create") onFormChange({ dueAt: value });
                  else onCommit({ due_at: value ? `${value}T00:00:00Z` : null });
                }}
              />
            </PropertyRow>
            {task && (
              <>
                <PropertyRow icon={ClockOutline} label={t("research.chain_tasks.submitted_at")}>
                  <ReadOnlyValue value={formatResearchDateTime(task.submitted_at, locale)} />
                </PropertyRow>
                <PropertyRow icon={CompletedAtOutline} label={t("research.chain_tasks.completed_at")}>
                  <ReadOnlyValue value={formatResearchDateTime(task.completed_at, locale)} />
                </PropertyRow>
                <PropertyRow icon={UpdatedAtOutline} label={t("research.chain_tasks.updated_at")}>
                  <ReadOnlyValue value={formatResearchDateTime(task.updated_at, locale)} />
                </PropertyRow>
                <PropertyRow icon={CreatedAtOutline} label={t("research.chain_tasks.created_at")}>
                  <ReadOnlyValue value={formatResearchDateTime(task.created_at, locale)} />
                </PropertyRow>
                <PropertyRow icon={ReplyOutline} label={t("research.chain_tasks.return_reason")}>
                  <ReadOnlyValue value={task.return_reason || ""} />
                </PropertyRow>
                {task.resource_type !== "NONE" && (
                  <PropertyRow icon={FileOutline} label={t("research.chain_tasks.resource")}>
                    <ReadOnlyValue value={resourceLabel(task.resource_type, t)} />
                  </PropertyRow>
                )}
              </>
            )}
          </div>
          {kind === "create" && (
            <p className="mt-3 text-12 text-tertiary">{t("research.chain_tasks.ownership_hint")}</p>
          )}
        </section>

        {task && (
          <section>
            <div className="flex items-center justify-between">
              <h3 className="text-12 font-medium text-primary">{t("research.chain_tasks.activity")}</h3>
              <button
                type="button"
                aria-label={t("research.chain_tasks.activity_sort")}
                className="grid size-7 place-items-center rounded-sm text-tertiary hover:bg-surface-2 hover:text-secondary"
                onClick={() => setActivityOrder((current) => (current === "asc" ? "desc" : "asc"))}
              >
                {activityOrder === "asc" ? (
                  <SortAscendingOutline className="size-4" />
                ) : (
                  <SortDescendingOutline className="size-4" />
                )}
              </button>
            </div>
            {activity.length ? (
              <div className="mt-2">
                {activity.map((item, index) => (
                  <ActivityRow key={item.id} item={item} locale={locale} last={index === activity.length - 1} />
                ))}
              </div>
            ) : (
              <p className="mt-3 text-12 text-tertiary">{t("research.chain_tasks.activity_empty")}</p>
            )}
          </section>
        )}

        {kind === "create" && (
          <Button variant="primary" size="sm" disabled={formBusy} onClick={onCreate}>
            {formBusy ? t("research.chain_tasks.saving") : t("research.chain_tasks.create")}
          </Button>
        )}
        {formError && (
          <p className="text-12 text-danger-primary" role="alert">
            {formError}
          </p>
        )}
      </div>
    </ResearchChainWorkbenchPeek>
  );
}

/**
 * 读取关联资料类型的稳定文案。
 *
 * Args:
 *   resourceType: 任务上的资料类型。
 *   t: 翻译函数。
 *
 * Returns:
 *   已翻译的类型名；未知类型回退原值。
 */
function resourceLabel(resourceType: TResearchChainNodeTaskResourceType, t: (key: string) => string) {
  const key = `research.chain_tasks.resources.${resourceType}`;
  const label = t(key);
  return label === key ? resourceType : label;
}

/**
 * 详情顶栏：关闭、布局切换，以及不常驻的更多动作。
 */
function TaskPeekHeader({
  mode,
  formBusy,
  lifecycle,
  actionBusy,
  onModeChange,
  onClose,
  onAction,
}: {
  mode: TWorkbenchPeekMode;
  formBusy: boolean;
  lifecycle: TLifecycleAction[];
  actionBusy: string;
  onModeChange: (mode: TWorkbenchPeekMode) => void;
  onClose: () => void;
  onAction: (action: TLifecycleAction) => void;
}) {
  const { t } = useTranslation();
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const current = PEEK_MODES.find((item) => item.key === mode) ?? PEEK_MODES[0];
  const CurrentIcon = current.icon;

  return (
    <div className={cn("flex items-center justify-between gap-3 p-4", mode === "full" && "border-b border-subtle")}>
      <div className="flex items-center gap-4">
        <button
          type="button"
          aria-label={t("research.chain_tasks.close")}
          className="text-tertiary hover:text-secondary"
          onClick={onClose}
        >
          <ArrowNarrowRightOutline className="h-4 w-4" />
        </button>
        <div className="relative" data-task-menu="">
          <button
            type="button"
            aria-label={t("research.chain_tasks.peek_layout")}
            className="text-tertiary hover:text-secondary"
            onClick={() => setLayoutOpen((open) => !open)}
          >
            <CurrentIcon className="h-4 w-4" />
          </button>
          {layoutOpen && (
            <div
              role="menu"
              className="absolute top-7 left-0 z-20 min-w-36 rounded-md border border-subtle bg-surface-1 p-1 shadow-[0_8px_24px_rgba(37,37,34,0.08)]"
            >
              {PEEK_MODES.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-12 text-secondary hover:bg-surface-2"
                  onClick={() => {
                    onModeChange(item.key);
                    setLayoutOpen(false);
                  }}
                >
                  <item.icon className="h-4 w-4" />
                  {t(item.label)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {formBusy && <span className="text-11 text-tertiary">{t("research.chain_tasks.saving")}</span>}
        {lifecycle.length > 0 && (
          <div className="relative" data-task-menu="">
            <button
              type="button"
              aria-label={t("research.chain_tasks.more")}
              className="text-tertiary hover:text-secondary"
              onClick={() => setMoreOpen((open) => !open)}
            >
              <MoreHorizontalOutline className="h-4 w-4" />
            </button>
            {moreOpen && (
              <div
                role="menu"
                className="absolute top-7 right-0 z-20 min-w-32 rounded-md border border-subtle bg-surface-1 p-1 shadow-[0_8px_24px_rgba(37,37,34,0.08)]"
              >
                {lifecycle.map((action) => (
                  <button
                    key={action}
                    type="button"
                    role="menuitem"
                    disabled={Boolean(actionBusy)}
                    className="block w-full rounded-sm px-2 py-1.5 text-left text-12 text-primary hover:bg-surface-2"
                    onClick={() => {
                      setMoreOpen(false);
                      onAction(action);
                    }}
                  >
                    {t(`research.chain_tasks.${action}`)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 对齐行政工作项的属性行：图标、固定标签、左侧控件。
 */
function PropertyRow({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof StateOutline;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="flex h-7 w-28 shrink-0 items-center gap-1.5 text-12 text-tertiary">
        <Icon className="size-4 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <div className="flex min-w-0 grow items-center">{children}</div>
    </div>
  );
}

/**
 * 只读属性值。空值用破折号，避免把表单输入框铺满详情。
 */
function ReadOnlyValue({ value }: { value: string }) {
  return <span className="px-2 text-12 text-primary">{value || "—"}</span>;
}

/**
 * 状态不是自由下拉，只展示当前状态和后端允许的流转。
 */
function StatusControl({
  status,
  label,
  actions,
  disabled,
  onAction,
}: {
  status: TResearchChainNodeTask["status"];
  label: string;
  actions: TLifecycleAction[];
  disabled: boolean;
  onAction: (action: TLifecycleAction) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!actions.length) {
    return (
      <ResearchStatusBadge status={status} size="sm">
        {label}
      </ResearchStatusBadge>
    );
  }
  return (
    <div className="relative" data-task-menu="">
      <button
        type="button"
        className="rounded-sm px-1 hover:bg-surface-2"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <ResearchStatusBadge status={status} size="sm">
          {label}
        </ResearchStatusBadge>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-8 left-0 z-20 min-w-28 rounded-md border border-subtle bg-surface-1 p-1 shadow-[0_8px_24px_rgba(37,37,34,0.08)]"
        >
          {actions.map((action) => (
            <button
              key={action}
              type="button"
              role="menuitem"
              className="block w-full rounded-sm px-2 py-1.5 text-left text-12 text-primary hover:bg-surface-2"
              onClick={() => {
                setOpen(false);
                onAction(action);
              }}
            >
              {t(`research.chain_tasks.${action}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 任务说明。空时显示“点击添加描述”，已有内容则就地编辑。
 */
function InstructionField({
  value,
  canEdit,
  editing,
  onEdit,
  onChange,
  onBlur,
}: {
  value: string;
  canEdit: boolean;
  editing: boolean;
  onEdit: () => void;
  onChange: (value: string) => void;
  onBlur: (value: string) => void;
}) {
  const { t } = useTranslation();
  if (editing && canEdit) {
    return (
      <textarea
        aria-label={t("research.chain_tasks.instruction")}
        value={value}
        rows={4}
        placeholder={t("research.chain_tasks.add_instruction")}
        onChange={(event) => onChange(event.target.value)}
        onBlur={(event) => onBlur(event.target.value)}
        className="w-full resize-none border-0 bg-transparent p-0 text-13 text-primary outline-none placeholder:text-placeholder"
      />
    );
  }
  if (!value.trim()) {
    if (!canEdit) return null;
    return (
      <button type="button" className="text-left text-13 text-placeholder hover:text-secondary" onClick={onEdit}>
        {t("research.chain_tasks.add_instruction")}
      </button>
    );
  }
  if (!canEdit) return <p className="text-13 whitespace-pre-wrap text-primary">{value}</p>;
  return (
    <button type="button" className="text-left text-13 whitespace-pre-wrap text-primary" onClick={onEdit}>
      {value}
    </button>
  );
}

/**
 * 截止日期控件。空值用添加提示，而不是常驻日期输入框。
 */
function DueDateControl({
  value,
  locale,
  label,
  placeholder,
  disabled,
  onChange,
}: {
  value: string;
  locale: string;
  label: string;
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const display = formatResearchDate(value, locale);
  if (disabled) return <ReadOnlyValue value={display} />;
  return (
    <div className="relative" data-task-menu="">
      <button
        type="button"
        aria-label={label}
        className={cn(
          "flex h-7 items-center gap-2 rounded-sm px-2 text-12 hover:bg-surface-2",
          display ? "text-primary" : "text-placeholder"
        )}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{display || placeholder}</span>
        {value && <ResearchTodoUrgency dueAt={value} />}
      </button>
      {open && (
        <div className="absolute top-8 left-0 z-20 rounded-md border border-subtle bg-surface-1 p-2 shadow-[0_8px_24px_rgba(37,37,34,0.08)]">
          <input
            type="date"
            aria-label={label}
            value={toDateInput(value)}
            onChange={(event) => {
              setOpen(false);
              onChange(event.target.value);
            }}
            className="rounded-md border border-subtle bg-surface-1 px-2 py-1 text-12 text-primary"
          />
        </div>
      )}
    </div>
  );
}

/**
 * 单条活动。结构对齐行政工作项活动流：图标、执行者、动作、时间。
 */
function ActivityRow({ item, locale, last }: { item: TActivityItem; locale: string; last: boolean }) {
  return (
    <div className="relative flex gap-3 py-2 text-12">
      {!last && <span className="bg-subtle-1 absolute top-7 bottom-0 left-3 w-px" aria-hidden />}
      <span className="relative z-[1] grid size-6 shrink-0 place-items-center rounded-md border border-subtle bg-surface-1 text-tertiary">
        <ActivityOutline className="size-3.5" />
      </span>
      <p className="min-w-0 text-secondary">
        {item.actor && <span className="font-medium text-primary">{item.actor} </span>}
        <span>{item.verb}</span>
        <span className="text-tertiary"> {formatResearchDateTime(item.at, locale)}</span>
        {item.detail && <span className="mt-1 block whitespace-pre-wrap text-primary">{item.detail}</span>}
      </p>
    </div>
  );
}
