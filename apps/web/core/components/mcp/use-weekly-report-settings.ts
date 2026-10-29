import { useCallback, useEffect, useRef, useState } from "react";
import {
  WeeklyReportMCPService,
  type WeeklyReportConnection,
  type WeeklyReportIssueRequest,
  type WeeklyReportProblem,
} from "@/services/weekly-report-mcp.service";
import type { MCPConfig } from "./connection-config";
import { weeklyReportConfig } from "./weekly-report-config";

const service = new WeeklyReportMCPService();
export const weeklyReportErrorMessage = (error: unknown) =>
  (error as WeeklyReportProblem)?.message || "服务请求失败，请刷新后重试。";

export function useWeeklyReportConnections(slug: string) {
  const [rows, setRows] = useState<WeeklyReportConnection[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState("");
  const live = useRef(false);
  const loading = useRef(false);
  const csrf = useRef("");
  const failedCursor = useRef<string | undefined>(undefined);
  const sequence = useRef(0);

  const load = useCallback(
    async (next?: string) => {
      if (loading.current) return;
      loading.current = true;
      const request = ++sequence.current;
      setPhase("loading");
      setError("");
      failedCursor.current = next;
      // Only the current request may publish its outcome, including during StrictMode replay.
      let outcome: "ready" | "error" = "error";
      try {
        const page = await service.connections(slug, next);
        if (!live.current || request !== sequence.current) return;
        csrf.current = page.csrf_token;
        const own = page.results.filter((row) => row.workspace === slug);
        setRows((previous) => [...new Map([...(next ? previous : []), ...own].map((row) => [row.id, row])).values()]);
        setCursor(page.next_cursor);
        outcome = "ready";
      } catch (failure) {
        if (live.current && request === sequence.current) setError(weeklyReportErrorMessage(failure));
      } finally {
        if (request === sequence.current) {
          loading.current = false;
          if (live.current) setPhase(outcome);
        }
      }
    },
    [slug]
  );

  useEffect(() => {
    live.current = true;
    loading.current = false;
    void load();
    return () => {
      live.current = false;
    };
    // The workspace-keyed owner unmounts all credentials and pagination on a switch.
  }, [load]);

  return {
    rows,
    cursor,
    error,
    ready: phase === "ready",
    busy: phase === "loading",
    live,
    loading,
    csrf,
    failedCursor,
    load,
  };
}

export function useWeeklyReportMutations(slug: string, list: ReturnType<typeof useWeeklyReportConnections>) {
  const [phase, setPhase] = useState<"idle" | "issuing" | "revoking">("idle");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [result, setResult] = useState<{ id: string; expires: string; config: MCPConfig }>();
  const [revoke, setRevoke] = useState<WeeklyReportConnection | null>(null);
  const [revokeError, setRevokeError] = useState("");
  const writing = useRef(false);
  const canWrite = list.ready && !list.loading.current && Boolean(list.csrf.current);

  async function issue(request: WeeklyReportIssueRequest) {
    if (writing.current || list.loading.current || !canWrite || uncertain || result) return;
    writing.current = true;
    setPhase("issuing");
    setError("");
    setNotice("");
    try {
      const issued = await service.issue(slug, request, list.csrf.current);
      if (!list.live.current) return;
      const config = weeklyReportConfig(issued, slug);
      list.csrf.current = issued.csrf_token;
      setResult({ id: issued.id, expires: issued.expires_at, config });
      setNotice("连接已生成，请保存本次配置。");
      await list.load();
    } catch (failure) {
      if (!list.live.current) return;
      // An uncertain request may have created a grant. Recover by listing, never retry issuance.
      if ((failure as WeeklyReportProblem)?.uncertain !== false) {
        setUncertain(true);
        setError("签发结果尚未确认。已尝试刷新列表，请核对并撤销不需要的连接；密钥无法从列表找回。");
        await list.load();
      } else setError(weeklyReportErrorMessage(failure));
    } finally {
      writing.current = false;
      if (list.live.current) setPhase("idle");
    }
  }

  async function revokeConnection() {
    if (!revoke || writing.current || list.loading.current || !canWrite) return;
    const id = revoke.id;
    writing.current = true;
    setPhase("revoking");
    setRevokeError("");
    if (result?.id === id) setResult(undefined);
    try {
      await service.revoke(slug, id, list.csrf.current);
      if (!list.live.current) return;
      setRevoke(null);
      setNotice("周报连接已撤销。");
      await list.load();
    } catch (failure) {
      if (list.live.current) setRevokeError(weeklyReportErrorMessage(failure));
    } finally {
      writing.current = false;
      if (list.live.current) setPhase("idle");
    }
  }

  function clearResult() {
    setResult(undefined);
    setNotice("本次配置和密钥已清除。");
  }
  function confirmRecovery() {
    setUncertain(false);
    setError("");
  }
  function openRevoke(row: WeeklyReportConnection) {
    setRevokeError("");
    setRevoke(row);
  }
  function closeRevoke() {
    if (!writing.current) setRevoke(null);
  }

  return {
    busy: phase !== "idle",
    issuing: phase === "issuing",
    notice,
    error,
    uncertain,
    result,
    revoke,
    revokeError,
    issue,
    revokeConnection,
    clearResult,
    confirmRecovery,
    openRevoke,
    closeRevoke,
    setNotice,
  };
}
