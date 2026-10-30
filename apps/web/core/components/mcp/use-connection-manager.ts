import { useCallback, useEffect, useRef, useState } from "react";
import { useExpiration } from "@/hooks/use-expiration";

export type ConnectionMetadata = {
  id: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  configuration_available: boolean;
};
export type ConfigurationFiles = { toml: string; json: string };
export type ConnectionAdapter<T extends ConnectionMetadata, Issued, Input> = {
  list: (cursor?: string) => Promise<{ results: T[]; next_cursor: string | null; csrf_token: string }>;
  issue: (data: Input, csrf: string) => Promise<Issued>;
  configuration: (id: string, csrf: string) => Promise<Issued>;
  rotate: (id: string, csrf: string) => Promise<Issued>;
  revoke: (id: string, csrf: string) => Promise<unknown>;
  metadata: (issued: Issued) => T;
  files: (issued: Issued) => ConfigurationFiles;
  error: (error: unknown) => string;
};

/** 管理两类连接的列表、写操作及仅驻留当前详情的配置。 */
export function useConnectionManager<T extends ConnectionMetadata, Issued, Input>(
  adapter: ConnectionAdapter<T, Issued, Input>
) {
  const [rows, setRows] = useState<T[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [listError, setListError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [configLoading, setConfigLoading] = useState(false);
  const [config, setConfig] = useState<{ id: string; files: ConfigurationFiles } | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [notice, setNotice] = useState("");
  const csrf = useRef("");
  const epoch = useRef(0);
  const detailEpoch = useRef(0);
  const listing = useRef(false);
  const writing = useRef(false);
  const failedCursor = useRef<string | undefined>(undefined);
  const selected = rows.find((row) => row.id === selectedId);
  const expired = useExpiration(selected?.expires_at ?? null);
  const active = Boolean(selected && !selected.revoked_at && (selected.expires_at === null || expired === false));

  /** 取消配置请求的发布资格，并清除内存密钥。 */
  const hideConfiguration = useCallback(() => {
    detailEpoch.current += 1;
    setConfig(null);
    setConfigLoading(false);
  }, []);

  useEffect(() => {
    if (!selected || selected.revoked_at || expired === true) hideConfiguration();
  }, [selected, expired, hideConfiguration]);

  useEffect(() => {
    window.addEventListener("pagehide", hideConfiguration);
    return () => window.removeEventListener("pagehide", hideConfiguration);
  }, [hideConfiguration]);

  /** 分页失败保留已加载记录，并记录准确的重试游标。 */
  const load = useCallback(
    async (next?: string) => {
      if (listing.current) return;
      hideConfiguration();
      listing.current = true;
      const expected = epoch.current;
      failedCursor.current = next;
      setLoading(true);
      setListError("");
      try {
        const page = await adapter.list(next);
        if (epoch.current !== expected) return;
        csrf.current = page.csrf_token;
        setRows((before) => [
          ...new Map([...(next ? before : []), ...page.results].map((row) => [row.id, row])).values(),
        ]);
        setCursor(page.next_cursor);
        setReady(true);
      } catch (failure) {
        if (epoch.current === expected) setListError(adapter.error(failure));
      } finally {
        if (epoch.current === expected) {
          listing.current = false;
          setLoading(false);
        }
      }
    },
    [adapter, hideConfiguration]
  );

  useEffect(() => {
    epoch.current += 1;
    listing.current = false;
    void load();
    return () => {
      epoch.current += 1;
      detailEpoch.current += 1;
    };
  }, [load]);

  /** 切换详情时丢弃前一条连接的配置和错误状态。 */
  function select(id: string | null) {
    hideConfiguration();
    setError("");
    setNotice("");
    setSelectedId(id);
  }

  /** 显式确认后创建；结果不确定时只刷新列表，不重复创建。 */
  async function issue(data: Input) {
    if (writing.current || !ready || !csrf.current || uncertain) return false;
    writing.current = true;
    const expected = epoch.current;
    hideConfiguration();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const issued = await adapter.issue(data, csrf.current);
      if (epoch.current !== expected) return false;
      const row = adapter.metadata(issued);
      setRows((before) => [row, ...before.filter((item) => item.id !== row.id)]);
      setSelectedId(row.id);
      setNotice("连接已创建。");
      try {
        setConfig({ id: row.id, files: adapter.files(issued) });
      } catch {
        setError("连接已创建，配置暂时无法显示。请在详情中重新查看配置。");
      }
      return true;
    } catch (failure) {
      if (epoch.current !== expected) return false;
      const status = (failure as { status?: number })?.status;
      if (!status || status >= 500) {
        setUncertain(true);
        setError("创建结果尚未确认，请核对连接列表；若已创建，可选中连接查看配置。");
        await load();
      } else setError(adapter.error(failure));
      return false;
    } finally {
      if (epoch.current === expected) {
        writing.current = false;
        setBusy(false);
      }
    }
  }

  /** 按需获取配置；切换连接和隐藏操作会使迟到的响应失效。 */
  async function reveal() {
    if (!selectedId || configLoading || writing.current || !csrf.current) return;
    const id = selectedId;
    const expected = epoch.current;
    const detail = ++detailEpoch.current;
    setConfig(null);
    setError("");
    setConfigLoading(true);
    try {
      const value = await adapter.configuration(id, csrf.current);
      if (epoch.current !== expected || detailEpoch.current !== detail) return;
      setConfig({ id, files: adapter.files(value) });
    } catch (failure) {
      if (epoch.current === expected && detailEpoch.current === detail) setError(adapter.error(failure));
    } finally {
      if (epoch.current === expected && detailEpoch.current === detail) setConfigLoading(false);
    }
  }

  /** 确认后重置或撤销，成功响应前不改写列表中的连接状态。 */
  async function mutate(action: "rotate" | "revoke", id: string) {
    if (writing.current || !csrf.current) return false;
    writing.current = true;
    const expected = epoch.current;
    hideConfiguration();
    const detail = detailEpoch.current;
    setBusy(true);
    setError("");
    try {
      if (action === "rotate") {
        const value = await adapter.rotate(id, csrf.current);
        if (epoch.current !== expected) return false;
        const row = adapter.metadata(value);
        setRows((before) => before.map((item) => (item.id === id ? row : item)));
        setNotice("密钥已重置，请更新客户端配置。");
        try {
          if (detailEpoch.current === detail) setConfig({ id, files: adapter.files(value) });
        } catch {
          setError("密钥已重置，配置暂时无法显示。请在详情中重新查看配置。");
        }
      } else {
        await adapter.revoke(id, csrf.current);
        if (epoch.current !== expected) return false;
        setRows((before) =>
          before.map((row) =>
            row.id === id ? { ...row, revoked_at: new Date().toISOString(), configuration_available: false } : row
          )
        );
        setNotice("连接已撤销。");
      }
      return true;
    } catch (failure) {
      if (epoch.current !== expected) return false;
      const status = (failure as { status?: number })?.status;
      if (action === "rotate" && (!status || status >= 500)) {
        await load();
        if (epoch.current !== expected) return false;
        setError("重置结果尚未确认，请查看配置核对当前密钥，避免重复重置。");
        return true;
      }
      setError(adapter.error(failure));
      return false;
    } finally {
      if (epoch.current === expected) {
        writing.current = false;
        setBusy(false);
      }
    }
  }

  return {
    rows,
    selectedId,
    selected,
    cursor,
    loading,
    ready,
    listError,
    error,
    busy,
    configLoading,
    config: active && config?.id === selectedId ? config.files : null,
    uncertain,
    notice,
    load,
    retry: () => load(failedCursor.current),
    select,
    issue,
    reveal,
    mutate,
    hideConfiguration,
    setNotice,
    confirmRecovery: () => {
      setUncertain(false);
      setError("");
    },
  };
}
