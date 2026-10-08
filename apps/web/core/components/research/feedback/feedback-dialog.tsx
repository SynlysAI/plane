import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { API_BASE_URL } from "@plane/constants";
import { Button } from "@plane/propel/button";
import { ModalCore } from "@plane/ui";
import { MessageSquare } from "lucide-react";
import { ResearchAgentService } from "@/services/research/agent.service";
import { useResearch } from "@/hooks/store/use-research";

const service = new ResearchAgentService();
const STATUS = { open: "待处理", in_progress: "处理中", done: "已解决", closed: "已关闭" };
type Feedback = {
  feedback_id: string;
  content: string;
  feedback_type: string;
  status: keyof typeof STATUS;
  username: string;
  path: string;
  browser: string;
  created_at: string;
  screenshots: { id: string; content_type: string; size: number }[];
  history: {
    actor_name: string;
    from_status: keyof typeof STATUS;
    to_status: keyof typeof STATUS;
    comment: string;
    created_at: string;
  }[];
};
type Shot = { file: File; preview: string };

/** 全局反馈与本人记录，管理者在同一管理视图处置组织范围内反馈。 */
export const FeedbackDialog = observer(function FeedbackDialog({
  workspaceSlug,
  managementOnly = false,
}: {
  workspaceSlug: string;
  managementOnly?: boolean;
}) {
  const research = useResearch();
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
  const [status, setStatus] = useState<keyof typeof STATUS>("in_progress");
  const [comment, setComment] = useState("");
  const [filter, setFilter] = useState({
    status: "",
    feedback_type: "",
    module: "",
    q: "",
    date_from: "",
    date_to: "",
  });
  const [page, setPage] = useState(1);
  const [count, setCount] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const idempotency = useRef(crypto.randomUUID());
  const queryVersion = useRef(0);
  const base = `/api/research/workspaces/${workspaceSlug}/feedback/`;
  const canManage = Boolean(
    research.identity?.user.is_main_pi ||
    research.identity?.user.is_workspace_admin ||
    research.identity?.user.is_system_admin
  );
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
    const version = ++queryVersion.current;
    const params = { ...filter, page: String(page), ...(view === "manage" ? { scope: "manage" } : {}) };
    void service
      .get(base, { params })
      .then((response) => {
        if (version !== queryVersion.current) return undefined;
        setResults(response.data.data.results);
        setCount(response.data.data.count);
        setError("");
        return undefined;
      })
      .catch(() => {
        if (version === queryVersion.current) setError("反馈读取失败，请重试。");
      });
    return () => {
      queryVersion.current += 1;
    };
  }, [base, filter, open, page, refresh, view]);
  const className = "w-full rounded-md border border-subtle bg-surface-1 px-3 py-2 text-13 text-primary";

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
      await service.post(base, form);
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
      <div role="tablist" aria-label="反馈视图" className="flex gap-4 border-b border-subtle">
        {!managementOnly &&
          [
            ["submit", "提交反馈"],
            ["mine", "我的反馈"],
          ].map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={view === value}
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
        {canManage && (
          <button
            role="tab"
            aria-selected={view === "manage"}
            className="pb-2 text-13"
            onClick={() => {
              setView("manage");
              setPage(1);
              setSelected(null);
            }}
          >
            反馈管理
          </button>
        )}
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
                <img src={shot.preview} alt={`截图 ${index + 1} 预览`} className="h-20 w-28 rounded object-contain" />
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
                setFilter((current) => ({ ...current, status: event.target.value }));
                setPage(1);
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
                setFilter((current) => ({ ...current, feedback_type: event.target.value }));
                setPage(1);
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
                  setFilter((current) => ({ ...current, [key]: event.target.value }));
                  setPage(1);
                }}
              />
            ))}
            <button type="button" className="text-12 text-secondary" onClick={() => setRefresh((value) => value + 1)}>
              刷新
            </button>
          </div>
          <div className="max-w-full overflow-x-auto">
            <table className="w-full min-w-100 text-left text-13">
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
                    <td>{record.created_at.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!results.length && <p className="text-13 text-secondary">当前范围内没有反馈记录。</p>}
          <div className="flex items-center gap-3 text-12">
            <Button variant="secondary" size="sm" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>
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
              <p className="mt-2 text-12 text-tertiary">{selected.path}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {selected.screenshots.map((shot, index) => (
                  <a
                    key={shot.id}
                    href={`${API_BASE_URL}${base}${selected.feedback_id}/screenshots/${shot.id}/${view === "manage" ? "?scope=manage" : ""}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <img
                      className="h-24 w-32 rounded object-contain"
                      alt={`反馈截图 ${index + 1}`}
                      src={`${API_BASE_URL}${base}${selected.feedback_id}/screenshots/${shot.id}/${view === "manage" ? "?scope=manage" : ""}`}
                    />
                  </a>
                ))}
              </div>
              <ol className="mt-3 space-y-2">
                {selected.history.map((entry) => (
                  <li key={`${entry.created_at}-${entry.to_status}`} className="border-l border-subtle pl-3 text-12">
                    <p>
                      {STATUS[entry.from_status]} → {STATUS[entry.to_status]} · {entry.actor_name}
                    </p>
                    <p>{entry.comment}</p>
                    <time className="text-tertiary">{entry.created_at}</time>
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
                      const response = await service.patch(`${base}${selected.feedback_id}/status/`, {
                        status,
                        comment,
                      });
                      setSelected(response.data.data);
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
