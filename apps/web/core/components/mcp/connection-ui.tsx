import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Copy, Download, Eye, EyeOff, RefreshCw } from "lucide-react";
import { Button } from "@plane/propel/button";
import { AlertModalCore, EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { copyTextToClipboard } from "@plane/utils";
import { LocalDate } from "@/components/core/local-date";
import { useExpiration } from "@/hooks/use-expiration";
import { downloadMCPConfiguration } from "./connection-download";
import type { ConfigurationFiles, ConnectionMetadata } from "./use-connection-manager";

export const MCP_INPUT = "w-full rounded border border-subtle bg-surface-1 px-3 py-2 text-primary";
const ICON_BUTTON = "rounded p-2 text-secondary hover:bg-surface-2 focus-visible:outline-2 disabled:opacity-50";
export const DEFAULT_LIFETIMES = [1, 7, 30, 365, null];

/** 显示连接生命周期，永久连接不依赖浏览器日期解析。 */
export function ConnectionStatus({ row }: { row: ConnectionMetadata }) {
  const expired = useExpiration(row.expires_at);
  return (
    <span className="shrink-0 text-12 text-secondary">
      {row.revoked_at
        ? "已撤销"
        : row.expires_at === null
          ? "有效"
          : expired === null
            ? "核对中"
            : expired
              ? "已过期"
              : "有效"}
    </span>
  );
}

/** 两类连接共用有效期选项。 */
export function LifetimeSelect({
  value,
  onChange,
  options = DEFAULT_LIFETIMES,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  options?: (number | null)[];
}) {
  return (
    <label className="block max-w-xs space-y-2">
      <span>有效期</span>
      <select
        aria-label="连接有效期"
        className={MCP_INPUT}
        value={value ?? "never"}
        onChange={(event) => onChange(event.target.value === "never" ? null : Number(event.target.value))}
      >
        {options.map((days) => (
          <option key={days ?? "never"} value={days ?? "never"}>
            {days === null ? "永不过期" : days === 365 ? "一年" : `${days} 天`}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 在一次弹窗内命名并确认授权；取消不发送创建请求。 */
export function CreateConnectionDialog({
  open,
  onClose,
  onConfirm,
  busy,
  error,
  summary,
  blocked = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (name: string) => Promise<unknown>;
  busy: boolean;
  error: string;
  summary: ReactNode;
  blocked?: boolean;
}) {
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const valid =
    name.trim().length > 0 &&
    name.trim().length <= 100 &&
    !Array.from(name).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  useEffect(() => {
    if (open) {
      setName("");
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);
  return (
    <ModalCore
      isOpen={open}
      handleClose={() => {
        if (!busy) onClose();
      }}
      position={EModalPosition.CENTER}
      width={EModalWidth.XXL}
    >
      <form
        className="space-y-5 p-5"
        aria-labelledby={titleId}
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !busy && !blocked) void onConfirm(name.trim());
        }}
      >
        <h2 id={titleId} className="text-16 font-semibold">
          确认创建连接
        </h2>
        <label className="block space-y-2">
          <span>连接名称</span>
          <input
            ref={input}
            required
            maxLength={100}
            disabled={busy}
            aria-label="连接名称"
            className={MCP_INPUT}
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
          />
        </label>
        <div className="space-y-2 text-13 text-secondary">{summary}</div>
        {error && (
          <p role="alert" className="text-13">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={busy || !valid || blocked}>
            {busy ? "正在创建…" : "确认生成"}
          </Button>
        </div>
      </form>
    </ModalCore>
  );
}

/** 以一致的定义列表展示连接时间。 */
export function ConnectionDates({ row }: { row: ConnectionMetadata }) {
  return (
    <dl className="grid gap-3 text-13 sm:grid-cols-2">
      <div>
        <dt className="text-secondary">创建时间</dt>
        <dd className="mt-1">
          <LocalDate value={row.created_at} />
        </dd>
      </div>
      <div>
        <dt className="text-secondary">到期时间</dt>
        <dd className="mt-1">{row.expires_at === null ? "永不过期" : <LocalDate value={row.expires_at} />}</dd>
      </div>
      <div>
        <dt className="text-secondary">最近使用</dt>
        <dd className="mt-1">
          <LocalDate value={row.last_used_at} emptyLabel="尚未使用" />
        </dd>
      </div>
    </dl>
  );
}

/** 配置格式页签及复制导出工具栏；密钥仅随显式显示请求加载。 */
function ConfigurationPanel({
  config,
  loading,
  available,
  active,
  reveal,
  hide,
  notice,
}: {
  config: ConfigurationFiles | null;
  loading: boolean;
  available: boolean;
  active: boolean;
  reveal: () => void;
  hide: () => void;
  notice: (value: string) => void;
}) {
  const [format, setFormat] = useState<"toml" | "json">("toml");
  const id = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <section aria-label="客户端配置" className="space-y-3 border-t border-subtle pt-5">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-14 font-semibold">客户端配置</h4>
        {config || loading ? (
          <button className={ICON_BUTTON} title="隐藏配置" aria-label="隐藏配置" onClick={hide}>
            <EyeOff className="size-4" />
          </button>
        ) : (
          <Button variant="secondary" disabled={!active || !available || loading} onClick={reveal}>
            <Eye className="mr-2 size-4" />
            {loading ? "正在加载…" : "查看配置"}
          </Button>
        )}
      </div>
      {!active ? (
        <p className="text-13 text-secondary">连接已过期或撤销。</p>
      ) : !available ? (
        <p className="text-13 text-secondary">
          此连接尚未保存可恢复密钥。重置密钥后可查看完整配置，原客户端需要更新配置。
        </p>
      ) : (
        !config && <p className="text-13 text-secondary">配置包含访问密钥。</p>
      )}
      {active && config && (
        <>
          <div className="flex items-center gap-2">
            <div role="tablist" aria-label="配置格式" className="flex min-w-0 flex-1 gap-4 border-b border-subtle">
              {(["toml", "json"] as const).map((value, index) => (
                <button
                  key={value}
                  role="tab"
                  type="button"
                  id={`${id}-${value}`}
                  aria-controls={`${id}-panel`}
                  aria-selected={format === value}
                  tabIndex={format === value ? 0 : -1}
                  ref={(el) => {
                    tabRefs.current[index] = el;
                  }}
                  className={`py-2 text-12 ${format === value ? "border-accent-primary border-b-2 font-medium" : "text-secondary"}`}
                  onClick={() => setFormat(value)}
                  onKeyDown={(event) => {
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                    event.preventDefault();
                    const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
                    setFormat(next ? "json" : "toml");
                    tabRefs.current[next]?.focus();
                  }}
                >
                  {value === "toml" ? "Codex TOML" : "通用 MCP JSON"}
                </button>
              ))}
            </div>
            <button
              className={ICON_BUTTON}
              title="复制配置"
              aria-label="复制配置"
              onClick={() => {
                void copyTextToClipboard(config[format]).then(
                  () => notice("配置已复制。"),
                  () => notice("复制失败，请手动选择配置。")
                );
              }}
            >
              <Copy className="size-4" />
            </button>
            <button
              className={ICON_BUTTON}
              title="导出配置"
              aria-label="导出配置"
              onClick={() => downloadMCPConfiguration(config[format], format)}
            >
              <Download className="size-4" />
            </button>
          </div>
          <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${format}`}>
            <textarea
              aria-label={`${format.toUpperCase()} 配置`}
              readOnly
              spellCheck={false}
              wrap="off"
              className="font-mono h-60 w-full min-w-0 resize-y rounded border border-subtle bg-surface-2 p-3 text-12"
              value={config[format]}
            />
          </div>
        </>
      )}
    </section>
  );
}

/** 两类连接共享的主从布局；窄屏提供独立详情和返回入口。 */
export function ConnectionBrowser<T extends ConnectionMetadata>({
  title,
  rows,
  selected,
  name,
  select,
  loading,
  listError,
  cursor,
  refresh,
  retry,
  more,
  busy,
  config,
  configLoading,
  reveal,
  hide,
  error,
  notice,
  setNotice,
  mutate,
  children,
}: {
  title: string;
  rows: T[];
  selected?: T;
  name: (row: T) => string;
  select: (id: string | null) => void;
  loading: boolean;
  listError: string;
  cursor: string | null;
  refresh: () => void;
  retry: () => void;
  more: () => void;
  busy: boolean;
  config: ConfigurationFiles | null;
  configLoading: boolean;
  reveal: () => void;
  hide: () => void;
  error: string;
  notice: string;
  setNotice: (value: string) => void;
  mutate: (action: "rotate" | "revoke", id: string) => Promise<boolean>;
  children: ReactNode;
}) {
  const [action, setAction] = useState<"rotate" | "revoke" | null>(null);
  const expired = useExpiration(selected?.expires_at ?? null);
  const active = Boolean(selected && !selected.revoked_at && (selected.expires_at === null || expired === false));
  return (
    <section aria-label={title} className="space-y-4 border-t border-subtle pt-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-16 font-semibold">{title}</h2>
        <button
          title="刷新连接列表"
          aria-label="刷新连接列表"
          className={ICON_BUTTON}
          disabled={loading || busy}
          onClick={refresh}
        >
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      {listError && (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p>{listError}</p>
          <Button variant="secondary" disabled={loading || busy} onClick={retry}>
            重试连接列表
          </Button>
        </div>
      )}
      {loading && (
        <p role="status" className="text-secondary">
          正在加载连接…
        </p>
      )}
      {!loading && !listError && !rows.length && <p className="text-secondary">尚无连接。</p>}
      {rows.length > 0 && (
        <div className="grid min-w-0 gap-5 md:grid-cols-[minmax(180px,1fr)_minmax(0,2fr)]">
          <div className={`${selected ? "hidden md:block" : ""} min-w-0`}>
            <ul aria-label="连接列表" className="divide-y divide-subtle">
              {rows.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    disabled={busy}
                    className={`w-full min-w-0 rounded px-3 py-3 text-left hover:bg-surface-2 ${selected?.id === row.id ? "bg-surface-2" : ""}`}
                    aria-current={selected?.id === row.id ? "true" : undefined}
                    aria-label={`查看连接 ${name(row)}`}
                    onClick={() => {
                      setAction(null);
                      select(row.id);
                    }}
                  >
                    <div className="flex items-start gap-2">
                      <span className="min-w-0 flex-1 font-medium break-words">{name(row)}</span>
                      <ConnectionStatus row={row} />
                    </div>
                    <span className="mt-1 block text-12 text-secondary">
                      <LocalDate value={row.created_at} dateOnly />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {cursor && (
              <Button variant="secondary" disabled={busy || loading} onClick={more}>
                加载更多连接
              </Button>
            )}
          </div>
          <div className={`${selected ? "" : "hidden md:block"} min-w-0 md:border-l md:border-subtle md:pl-5`}>
            {selected ? (
              <article aria-label={`连接详情 ${name(selected)}`} className="min-w-0 space-y-5">
                <button className={`${ICON_BUTTON} flex items-center gap-2 md:hidden`} onClick={() => select(null)}>
                  <ArrowLeft className="size-4" />
                  返回列表
                </button>
                <div className="flex items-start gap-3">
                  <h3 className="min-w-0 flex-1 text-16 font-semibold break-words">{name(selected)}</h3>
                  <ConnectionStatus row={selected} />
                </div>
                {children}
                <ConnectionDates row={selected} />
                <ConfigurationPanel
                  key={selected.id}
                  config={config}
                  loading={configLoading}
                  available={selected.configuration_available}
                  active={active}
                  reveal={reveal}
                  hide={hide}
                  notice={setNotice}
                />
                <div className="flex flex-wrap gap-3 border-t border-subtle pt-4">
                  <Button variant="secondary" disabled={busy || !active} onClick={() => setAction("rotate")}>
                    重置密钥
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy || Boolean(selected.revoked_at)}
                    onClick={() => setAction("revoke")}
                  >
                    撤销连接
                  </Button>
                </div>
              </article>
            ) : (
              <p className="py-4 text-secondary">选择连接查看详情。</p>
            )}
          </div>
        </div>
      )}
      {error && !action && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <AlertModalCore
        isOpen={Boolean(action && selected)}
        handleClose={() => {
          if (!busy) setAction(null);
        }}
        handleSubmit={async () => {
          if (action && selected && (await mutate(action, selected.id))) setAction(null);
        }}
        isSubmitting={busy}
        title={action === "rotate" ? "确认重置密钥" : "确认撤销连接"}
        primaryButtonText={{ default: action === "rotate" ? "确认重置" : "确认撤销", loading: "正在处理…" }}
        secondaryButtonText="取消"
        content={
          <>
            <span className="block">
              {action === "rotate"
                ? "旧密钥将失效，所有使用此连接的客户端需要更新配置。授权范围和到期时间保持原值。"
                : "撤销后，此连接将无法继续访问。操作不能恢复。"}
            </span>
            {error && (
              <span role="alert" className="mt-2 block">
                {error}
              </span>
            )}
          </>
        }
      />
    </section>
  );
}
