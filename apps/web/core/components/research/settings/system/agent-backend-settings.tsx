"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "@plane/i18n";
// services
import { ResearchAgentService } from "@/services/research/agent.service";

const agentService = new ResearchAgentService();

type TBackendConnection = {
  id: string;
  base_url: string;
  is_enabled: boolean;
  has_credential: boolean;
  health_status: string;
  last_health_at?: string;
  last_error: string;
};

/** 学生自助接入本地 ScienceDiscovery 实例的设置面板（§5）。 */
export function AgentBackendSettings({ workspaceSlug }: { workspaceSlug: string }) {
  const { t } = useTranslation();
  const [connection, setConnection] = useState<TBackendConnection | null>(null);
  const [governanceEnabled, setGovernanceEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await agentService.getBackendConnection(workspaceSlug);
      setConnection(data.connection);
      setGovernanceEnabled(data.governance_enabled);
      setBaseUrl(data.connection?.base_url ?? "");
      setEnabled(data.connection?.is_enabled ?? true);
    } catch {
      setError(t("research.agent_backend.load_failed"));
    }
  }, [t, workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (!baseUrl.trim()) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await agentService.saveBackendConnection(workspaceSlug, {
        base_url: baseUrl.trim(),
        ...(token.trim() ? { token: token.trim() } : {}),
        is_enabled: enabled,
      });
      setToken("");
      setStatus(t("research.agent_backend.saved"));
      await load();
    } catch (failure) {
      setError((failure as { message?: string })?.message ?? t("research.agent_backend.save_failed"));
    } finally {
      setBusy(false);
    }
  }, [baseUrl, enabled, load, t, token, workspaceSlug]);

  const test = useCallback(async () => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await agentService.testBackendConnection(workspaceSlug);
      setStatus(
        result.ok
          ? t("research.agent_backend.test_ok", { count: String(result.models ?? 0) })
          : t("research.agent_backend.test_failed", { error: result.error ?? "" })
      );
      await load();
    } catch (failure) {
      setError((failure as { message?: string })?.message ?? t("research.agent_backend.test_failed_generic"));
    } finally {
      setBusy(false);
    }
  }, [load, t, workspaceSlug]);

  const remove = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      await agentService.deleteBackendConnection(workspaceSlug);
      setStatus(t("research.agent_backend.removed"));
      await load();
    } catch {
      setError(t("research.agent_backend.remove_failed"));
    } finally {
      setBusy(false);
    }
  }, [load, t, workspaceSlug]);

  return (
    <section className="max-w-2xl space-y-4">
      <div className="border-y border-subtle py-3 text-12 text-secondary">
        <p>{t("research.agent_backend.default_runtime")}</p>
        {!governanceEnabled && <p className="mt-2 text-danger-primary">{t("research.agent_backend.governance_off")}</p>}
      </div>
      <label className="flex flex-col gap-1 text-11 text-secondary">
        {t("research.agent_backend.base_url")}
        <input
          value={baseUrl}
          onChange={(changeEvent) => setBaseUrl(changeEvent.target.value)}
          placeholder="http://192.168.1.10:5300"
          className="focus:border-accent-primary rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary outline-none"
        />
      </label>
      <label className="flex flex-col gap-1 text-11 text-secondary">
        {t("research.agent_backend.token")}
        <input
          type="password"
          value={token}
          onChange={(changeEvent) => setToken(changeEvent.target.value)}
          placeholder={connection?.has_credential ? t("research.agent_backend.token_kept") : ""}
          className="focus:border-accent-primary rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary outline-none"
        />
      </label>
      <label className="flex items-center gap-2 text-11 text-secondary">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        {t("research.agent_backend.enabled")}
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !baseUrl.trim()}
          className="rounded-md bg-accent-primary px-3 py-1.5 text-12 text-on-color disabled:opacity-50"
        >
          {busy ? t("research.agent_backend.busy") : t("research.agent_backend.save")}
        </button>
        {connection && (
          <>
            <button
              type="button"
              onClick={() => void test()}
              disabled={busy}
              className="rounded-md border border-subtle px-3 py-1.5 text-12 text-primary disabled:opacity-50"
            >
              {t("research.agent_backend.test")}
            </button>
            <button
              type="button"
              onClick={() => void remove()}
              disabled={busy}
              className="rounded-md border border-danger-strong/40 px-3 py-1.5 text-12 text-danger-primary disabled:opacity-50"
            >
              {t("research.agent_backend.remove")}
            </button>
          </>
        )}
      </div>
      {connection && (
        <p className="text-11 text-tertiary">
          {t("research.agent_backend.health", {
            status: connection.health_status,
            at: connection.last_health_at ?? "—",
          })}
        </p>
      )}
      {status && <p className="text-12 text-success-primary">{status}</p>}
      {error && (
        <p className="text-12 text-danger-primary" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
