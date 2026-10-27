import { useEffect, useState } from "react";
import { Button } from "@plane/propel/button";
import type { WeeklyReportConnection } from "@/services/weekly-report-mcp.service";
import type { useWeeklyReportConnections } from "./use-weekly-report-settings";
import { weeklyReportActionLabels } from "./weekly-report-config";

export function WeeklyReportDate({ value }: { value: string | null }) {
  if (!value) return <>尚未使用</>;
  return (
    <time dateTime={value}>
      {new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}（UTC+8）
    </time>
  );
}

export function WeeklyReportConnectionsList({
  list,
  busy,
  onRevoke,
}: {
  list: Pick<
    ReturnType<typeof useWeeklyReportConnections>,
    "rows" | "cursor" | "busy" | "ready" | "error" | "load" | "failedCursor"
  >;
  busy: boolean;
  onRevoke: (row: WeeklyReportConnection) => void;
}) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <section aria-label="已有周报连接" className="space-y-3">
      <div className="flex items-center gap-3">
        <h3 className="text-16 font-semibold">已有周报连接</h3>
        <Button variant="secondary" disabled={list.busy || busy} onClick={() => void list.load()}>
          刷新周报连接列表
        </Button>
      </div>
      {list.busy && <p role="status">正在加载周报连接…</p>}
      {list.error && (
        <div role="alert">
          {list.error}
          <Button
            variant="secondary"
            disabled={list.busy || busy}
            onClick={() => void list.load(list.failedCursor.current)}
          >
            重试周报连接列表
          </Button>
        </div>
      )}
      {list.ready && list.rows.length === 0 && <p>尚无周报连接。</p>}
      {list.rows.map((row) => (
        <WeeklyReportConnectionCard
          key={row.id}
          row={row}
          now={now}
          disabled={busy || list.busy || !list.ready}
          onRevoke={onRevoke}
        />
      ))}
      {list.cursor && (
        <Button variant="secondary" disabled={list.busy || busy} onClick={() => void list.load(list.cursor!)}>
          加载更多周报连接
        </Button>
      )}
    </section>
  );
}

function WeeklyReportConnectionCard({
  row,
  now,
  disabled,
  onRevoke,
}: {
  row: WeeklyReportConnection;
  now: number | null;
  disabled: boolean;
  onRevoke: (row: WeeklyReportConnection) => void;
}) {
  const status = row.revoked_at
    ? "已撤销"
    : now === null
      ? "正在核对有效期…"
      : Date.parse(row.expires_at) <= now
        ? "已到期"
        : "有效";
  return (
    <article className="space-y-2 rounded-lg border border-subtle p-4">
      <h4 className="font-medium break-words">{row.label}</h4>
      <p>
        权限：{row.actions.map((action) => weeklyReportActionLabels[action]).join("、")} · {status}
      </p>
      <p>
        到期时间：
        <WeeklyReportDate value={row.expires_at} /> · 最近使用：
        <WeeklyReportDate value={row.last_used_at} />
      </p>
      <Button
        variant="secondary"
        aria-label={`撤销周报连接：${row.label}`}
        disabled={Boolean(row.revoked_at) || disabled}
        onClick={() => onRevoke(row)}
      >
        撤销连接
      </Button>
    </article>
  );
}
