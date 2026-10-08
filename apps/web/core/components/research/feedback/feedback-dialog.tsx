import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import type { TFeedbackStatus, TResearchFeedback } from "@plane/types";
import { Button } from "@plane/propel/button";
import { ModalCore } from "@plane/ui";
import { MessageSquare } from "lucide-react";
import { formatResearchDateTime } from "@/components/research/common/research-format";
import { ResearchFeedbackService } from "@/services/research/feedback.service";
import { useResearch } from "@/hooks/store/use-research";

const service = new ResearchFeedbackService();
const STATUS: Record<TFeedbackStatus, string> = {
  open: "待处理",
  in_progress: "处理中",
  done: "已解决",
  closed: "已关闭",
};
const FEEDBACK_TYPE_LABELS: Record<Feedback["feedback_type"], string> = {
  bug: "缺陷",
  ux: "体验",
  idea: "建议",
  other: "其他",
};
type Feedback = TResearchFeedback;
type Shot = { file: File; preview: string };

/** 渲染专属反馈截图链接，并在对象读取失败时保留中性占位。 */
function ScreenshotLink({ url, index }: { url: string; index: number }) {
  const [failed, setFailed] = useState(false);

  return (
    <a href={url} target="_blank" rel="noreferrer" className="block">
      {failed ? (
        <span className="flex h-24 w-32 items-center justify-center rounded border border-subtle bg-surface-2 text-12 text-tertiary">
          截图暂不可用
        </span>
      ) : (
        <img
          className="h-24 w-32 rounded border border-subtle bg-surface-2 object-contain"
          alt={`反馈截图 ${index + 1}`}
          src={url}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
    </a>
  );
}

/** 全局反馈与本人记录，管理者在同一管理视图处置组织范围内反馈。 */
export const FeedbackDialog = observer(function FeedbackDialog({
  workspaceSlug,
  managementOnly = false,
}: {
  workspaceSlug: string;
  managementOnly?: boolean;
}) {
  const research = useResearch();
  const identity = research.identity;
  const identityKnown = Boolean(identity);
  const [open, setOpen] = useState(managementOnly);
  const [view, setView] = useState(managementOnly ? "manage" : "submit");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState("bug");
  const [shots, setShots] = useState<Shot[]>([]);
  const shotsRef = useRef(shots);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [results, setResults] = useState<Feedback[]>([]);
  const [selected, setSelected] = useState<Feedback | null>(null);
  const [status, setStatus] = useState<TFeedbackStatus>("in_progress");
  const [comment, setComment] = useState("");
  const [filterDraft, setFilterDraft] = useState({
    status: "",
    feedback_type: "",
    module: "",
    q: "",
    date_from: "",
    date_to: "",
  });
  const [filter, setFilter] = useState(filterDraft);
  const [page, setPage] = useState(1);
  const [count, setCount] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const idempotency = useRef(crypto.randomUUID());
  const queryVersion = useRef(0);
  const canManage = Boolean(
    identity?.user.is_main_pi || identity?.user.is_workspace_admin || identity?.user.is_system_admin
  );
  const managementDenied = managementOnly && identityKnown && !canManage;
  useEffect(() => {
    shotsRef.current = shots;
  }, [shots]);
  useEffect(
    () => () => {
      shotsRef.current.forEach((shot) => URL.revokeObjectURL(shot.preview));
    },
    []
  );
  useEffect(() => {
    if (!open || view === "submit") return;
    if (view === "manage" && !canManage) return;
    const version = ++queryVersion.current;
    const params = { ...filter, page: String(page), ...(view === "manage" ? { scope: "manage" } : {}) };
    setListLoading(true);
    void service
      .list(workspaceSlug, params)
      .then((data) => {
        if (version !== queryVersion.current) return undefined;
        setResults(data.results);
        setCount(data.count);
        setSelected((current) =>
          current ? (data.results.find((record) => record.feedback_id === current.feedback_id) ?? null) : null
        );
        setError("");
        return undefined;
      })
      .catch(() => {
        if (version === queryVersion.current) setError("反馈读取失败，请重试。");
        return undefined;
      })
      .finally(() => {
        if (version === queryVersion.current) setListLoading(false);
      });
    return () => {
      queryVersion.current += 1;
    };
  }, [canManage, filter, open, page, refresh, view, workspaceSlug]);
  useEffect(() => {
    if (!open || view === "submit") return undefined;
    const timer = setTimeout(() => {
      setFilter((current) =>
        current.q === filterDraft.q && current.module === filterDraft.module
          ? current
          : { ...current, q: filterDraft.q, module: filterDraft.module }
      );
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [filterDraft.module, filterDraft.q, open, view]);
  const className = "w-full rounded-md border border-subtle bg-surface-1 px-3 py-2 text-13 text-primary";
  /** 更新立即生效的筛选条件并重置分页。 */
  const updateFilter = (key: keyof typeof filter, value: string) => {
    setFilterDraft((current) => ({ ...current, [key]: value }));
    setFilter((current) => ({ ...current, [key]: value }));
    setPage(1);
  };
  const availableTabs = [
    ...(managementOnly
      ? []
      : ([
          ["submit", "提交反馈"],
          ["mine", "我的反馈"],
        ] as const)),
    ...(canManage ? [["manage", "反馈管理"] as const] : []),
  ];
  /** 按方向键在可用反馈视图之间切换。 */
  const moveTab = (direction: 1 | -1) => {
    const current = availableTabs.findIndex(([value]) => value === view);
    if (current < 0) return;
    const next = (current + direction + availableTabs.length) % availableTabs.length;
    setView(availableTabs[next][0]);
    setPage(1);
    setSelected(null);
  };

  /** 预览截图；每条限制三张，每张最多 10 MB。 */
  const addShots = (files: FileList | null) => {
    if (!files) return;
    const next = Array.from(files);
    if (
      shots.length + next.length > 3 ||
      next.some(
        (file) =>
          !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
          file.size > 10 * 1024 * 1024 ||
          file.size === 0
      )
    ) {
      setError("最多 3 张 PNG/JPEG/WebP 截图，每张不超过 10 MB。");
      return;
    }
    setShots((current) => [...current, ...next.map((file) => ({ file, preview: URL.createObjectURL(file) }))]);
    idempotency.current = crypto.randomUUID();
    setError("");
  };

  /** 成功后清空表单，失败保留文本和全部截图供同标识重试。 */
  const submit = async () => {
    if (busy || !content.trim()) return;
    setBusy(true);
    setMessage("");
    setError("");
    const form = new FormData();
    Object.entries({
      content,
      feedback_type: category,
      path: window.location.pathname,
      browser: navigator.userAgent.slice(0, 500),
      module: window.location.pathname.split("/")[2] || "plane",
      idempotency_key: idempotency.current,
    }).forEach(([key, value]) => form.append(key, value));
    shots.forEach((shot) => form.append("screenshots", shot.file));
    try {
      await service.create(workspaceSlug, form);
      setContent("");
      setShots([]);
      shots.forEach((shot) => URL.revokeObjectURL(shot.preview));
      idempotency.current = crypto.randomUUID();
      setMessage("反馈已提交，可在“我的反馈”查看处理状态。");
    } catch {
      setError("反馈提交失败，表单和截图已保留，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <section className="flex max-h-[85vh] min-w-0 flex-col gap-4 overflow-y-auto bg-surface-1 p-5">
      <h2 className="text-20 font-semibold">反馈</h2>
      <div
        role="tablist"
        aria-label="反馈视图"
        className="flex gap-4 border-b border-subtle"
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            moveTab(1);
          }
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            moveTab(-1);
          }
        }}
      >
        {availableTabs.map(([value, label]) => (
          <button
            key={value}
            type="button"
            id={`feedback-tab-${value}`}
            role="tab"
            aria-selected={view === value}
            aria-controls="feedback-tab-panel"
            tabIndex={view === value ? 0 : -1}
            className={`pb-2 text-13 ${view === value ? "font-semibold text-primary" : "text-secondary"}`}
            onClick={() => {
              setView(value);
              setPage(1);
              setSelected(null);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-13 text-danger-primary">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-13 text-secondary">
          {message}
        </p>
      )}
      {managementOnly && !identityKnown && (
        <p role="status" className="text-13 text-secondary">
          反馈权限读取中…
        </p>
      )}
      {managementOnly && identityKnown && !canManage && (
        <div role="alert" className="rounded-md border border-subtle bg-surface-2 px-4 py-6 text-13 text-secondary">
          <p className="font-medium text-primary">无权限访问反馈管理</p>
          <p className="mt-1">当前身份只能提交并查看自己的反馈。</p>
        </div>
      )}
      {!managementDenied && (
        <div
          role="tabpanel"
          id="feedback-tab-panel"
          aria-labelledby={`feedback-tab-${view}`}
          tabIndex={-1}
          className="flex min-h-0 flex-col"
        >
          {view === "submit" ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <label className="text-13">
                分类
                <select
                  aria-label="反馈分类"
                  className={className}
                  value={category}
                  onChange={(event) => {
                    setCategory(event.target.value);
                    idempotency.current = crypto.randomUUID();
                  }}
                >
                  <option value="bug">缺陷</option>
                  <option value="ux">体验</option>
                  <option value="idea">建议</option>
                  <option value="other">其他</option>
                </select>
              </label>
              <label className="text-13">
                描述
                <textarea
                  aria-label="反馈描述"
                  className={`${className} min-h-32`}
                  maxLength={5000}
                  required
                  value={content}
                  onChange={(event) => {
                    setContent(event.target.value);
                    idempotency.current = crypto.randomUUID();
                  }}
                />
              </label>
              <label className="text-13">
                截图（最多 3 张，每张 10 MB）
                <input
                  aria-label="反馈截图"
                  className="mt-2 block text-12"
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => {
                    addShots(event.target.files);
                    event.target.value = "";
                  }}
                />
              </label>
              <div className="flex flex-wrap gap-3">
                {shots.map((shot, index) => (
                  <figure key={shot.preview} className="w-28">
                    <img
                      src={shot.preview}
                      alt={`截图 ${index + 1} 预览`}
                      className="h-20 w-28 rounded object-contain"
                    />
                    <button
                      type="button"
                      className="text-12 text-secondary"
                      onClick={() => {
                        URL.revokeObjectURL(shot.preview);
                        setShots((current) => current.filter((item) => item !== shot));
                        idempotency.current = crypto.randomUUID();
                      }}
                    >
                      移除截图 {index + 1}
                    </button>
                  </figure>
                ))}
              </div>
              <p className="text-12 text-tertiary">仅提交当前路径和浏览器信息。截图长期保存，可在本人记录中查看。</p>
              <div className="flex justify-end">
                <Button type="submit" variant="primary" size="sm" disabled={busy || !content.trim()}>
                  {busy ? "提交中" : error ? "重试提交" : "提交反馈"}
                </Button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <select
                  aria-label="筛选状态"
                  className="rounded-md border border-subtle px-2 py-1 text-12"
                  value={filter.status}
                  onChange={(event) => {
                    updateFilter("status", event.target.value);
                  }}
                >
                  <option value="">全部状态</option>
                  {Object.entries(STATUS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="筛选分类"
                  className="rounded-md border border-subtle px-2 py-1 text-12"
                  value={filter.feedback_type}
                  onChange={(event) => {
                    updateFilter("feedback_type", event.target.value);
                  }}
                >
                  <option value="">全部分类</option>
                  <option value="bug">缺陷</option>
                  <option value="ux">体验</option>
                  <option value="idea">建议</option>
                  <option value="other">其他</option>
                </select>
                {(["q", "module", "date_from", "date_to"] as const).map((key) => (
                  <input
                    key={key}
                    aria-label={
                      key === "q"
                        ? "反馈关键词"
                        : key === "module"
                          ? "反馈模块"
                          : key === "date_from"
                            ? "反馈开始日期"
                            : "反馈结束日期"
                    }
                    placeholder={key === "q" ? "关键词" : "模块"}
                    type={key.startsWith("date") ? "date" : "text"}
                    value={filter[key]}
                    className="min-w-0 rounded-md border border-subtle px-2 py-1 text-12"
                    onChange={(event) => {
                      if (key === "q" || key === "module") {
                        setFilterDraft((current) => ({ ...current, [key]: event.target.value }));
                        return;
                      }
                      updateFilter(key, event.target.value);
                    }}
                  />
                ))}
                <button
                  type="button"
                  className="text-12 text-secondary"
                  onClick={() => setRefresh((value) => value + 1)}
                >
                  刷新
                </button>
                {view !== "submit" && error && (
                  <button
                    type="button"
                    className="text-12 text-secondary"
                    onClick={() => setRefresh((value) => value + 1)}
                  >
                    重试
                  </button>
                )}
              </div>
              <div className="max-w-full overflow-x-auto">
                <table className="w-full min-w-100 text-left text-13" aria-busy={listLoading}>
                  <thead>
                    <tr className="text-secondary">
                      <th className="p-2">描述</th>
                      <th>状态</th>
                      <th>提交时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((record) => (
                      <tr key={record.feedback_id} className="border-t border-subtle">
                        <td className="p-2">
                          <button
                            onClick={() => {
                              setSelected(record);
                              setComment("");
                            }}
                          >
                            {record.content.slice(0, 60)}
                          </button>
                        </td>
                        <td>{STATUS[record.status]}</td>
                        <td>{formatResearchDateTime(record.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {listLoading && (
                <p role="status" className="text-13 text-secondary">
                  {results.length ? "反馈刷新中…" : "反馈读取中…"}
                </p>
              )}
              {!listLoading && !error && !results.length && (
                <p className="text-13 text-secondary">当前范围内没有反馈记录。</p>
              )}
              <div className="flex items-center gap-3 text-12">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page === 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  上一页
                </Button>
                <span>
                  {page} · 共 {count} 条
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page * 20 >= count}
                  onClick={() => setPage((value) => value + 1)}
                >
                  下一页
                </Button>
              </div>
              {selected && (
                <article className="border-t border-subtle pt-4 text-13">
                  <h3 className="font-semibold">
                    {STATUS[selected.status]} · {selected.username}
                  </h3>
                  <p className="mt-2 whitespace-pre-wrap">{selected.content}</p>
                  <dl className="mt-3 grid gap-x-6 gap-y-2 text-12 sm:grid-cols-2">
                    <div className="min-w-0">
                      <dt className="text-tertiary">分类 / 模块</dt>
                      <dd className="mt-1 text-secondary">
                        {FEEDBACK_TYPE_LABELS[selected.feedback_type]} · {selected.module}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-tertiary">提交时间 / 处理时间</dt>
                      <dd className="mt-1 text-secondary">
                        {formatResearchDateTime(selected.created_at)}
                        {selected.updated_at ? ` · ${formatResearchDateTime(selected.updated_at)}` : ""}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-tertiary">页面路径</dt>
                      <dd className="mt-1 break-all text-secondary">{selected.path}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-tertiary">浏览器</dt>
                      <dd className="mt-1 break-words text-secondary">{selected.browser || "—"}</dd>
                    </div>
                  </dl>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {selected.screenshots.map((shot, index) => (
                      <ScreenshotLink
                        key={shot.id}
                        index={index}
                        url={service.screenshotUrl(workspaceSlug, selected.feedback_id, shot.id, view === "manage")}
                      />
                    ))}
                  </div>
                  <ol className="mt-3 space-y-2">
                    {selected.history.map((entry) => (
                      <li
                        key={`${entry.created_at}-${entry.to_status}`}
                        className="border-l border-subtle pl-3 text-12"
                      >
                        <p>
                          {STATUS[entry.from_status]} → {STATUS[entry.to_status]} · {entry.actor_name}
                        </p>
                        <p>{entry.comment}</p>
                        <time className="text-tertiary" dateTime={entry.created_at}>
                          {formatResearchDateTime(entry.created_at)}
                        </time>
                      </li>
                    ))}
                  </ol>
                  {view === "manage" && (
                    <form
                      className="mt-4 flex flex-col gap-2"
                      onSubmit={async (event) => {
                        event.preventDefault();
                        if (busy || !comment.trim()) return;
                        setBusy(true);
                        try {
                          const updated = await service.updateStatus(workspaceSlug, selected.feedback_id, {
                            status,
                            comment,
                          });
                          setSelected(updated);
                          setComment("");
                          setRefresh((value) => value + 1);
                          setError("");
                        } catch {
                          setError("处置失败，请刷新后重试。");
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      <select
                        aria-label="处置状态"
                        className={className}
                        value={status}
                        onChange={(event) => setStatus(event.target.value as keyof typeof STATUS)}
                      >
                        {Object.entries(STATUS).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <textarea
                        aria-label="处置说明"
                        className={className}
                        required
                        maxLength={2000}
                        value={comment}
                        onChange={(event) => setComment(event.target.value)}
                      />
                      <Button type="submit" variant="primary" size="sm" disabled={busy || !comment.trim()}>
                        更新状态
                      </Button>
                    </form>
                  )}
                </article>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
  if (managementOnly) return body;
  return (
    <>
      <button
        aria-label="提交反馈或查看我的反馈"
        className="flex size-8 items-center justify-center rounded-md text-secondary hover:bg-surface-2"
        onClick={() => setOpen(true)}
      >
        <MessageSquare className="size-4" />
      </button>
      <ModalCore isOpen={open} handleClose={() => !busy && setOpen(false)}>
        {body}
      </ModalCore>
    </>
  );
});
