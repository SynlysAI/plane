"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
export function AgentBackendSettings({
  workspaceSlug,
  workspaceName = workspaceSlug,
}: {
  workspaceSlug: string;
  workspaceName?: string;
}) {
  const { t } = useTranslation();
  const translateRef = useRef(t);
  const [connection, setConnection] = useState<TBackendConnection | null>(null);
  const [system, setSystem] = useState<"SCIENCE_DISCOVERY" | "SYNLORA">("SCIENCE_DISCOVERY");
  const [governanceEnabled, setGovernanceEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const loadSequence = useRef(0);
  const workspaceSequence = useRef(0);

  // 渲染期写 ref 违反 React 纯渲染规则，改为在 effect 中同步最新翻译函数。
  useEffect(() => {
    translateRef.current = t;
  }, [t]);

  /** 仅在工作区变化时重建，避免翻译函数引用变化触发重复加载。 */
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const data = await agentService.getBackendConnection(workspaceSlug, system);
      if (sequence !== loadSequence.current) return;
      setConnection(data.connection);
      setGovernanceEnabled(data.governance_enabled);
      setBaseUrl(data.connection?.base_url ?? "");
    } catch {
      if (sequence === loadSequence.current) setError(translateRef.current("research.agent_backend.load_failed"));
    } finally {
      if (sequence === loadSequence.current) {
        setLoading(false);
        setHasLoaded(true);
      }
    }
  }, [workspaceSlug, system]);

  useEffect(() => {
    workspaceSequence.current += 1;
    setHasLoaded(false);
    setConnection(null);
    setGovernanceEnabled(false);
    setBaseUrl("");
    setToken("");
    setStatus("");
    setError("");
    setBusy(false);
    void load();
    return () => {
      workspaceSequence.current += 1;
      loadSequence.current += 1;
    };
  }, [load]);

  const save = useCallback(async () => {
    if (system === "SCIENCE_DISCOVERY" && !baseUrl.trim()) return;
    if (system === "SYNLORA" && !baseUrl.trim() && !token.trim() && !connection?.has_credential) return;
    const sequence = workspaceSequence.current;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await agentService.saveBackendConnection(workspaceSlug, {
        system,
        base_url: system === "SCIENCE_DISCOVERY" ? baseUrl.trim() : "",
        ...(token.trim() ? { token: token.trim() } : {}),
        is_enabled: true,
      });
      if (sequence !== workspaceSequence.current) return;
      setToken("");
      setStatus(t("research.agent_backend.saved"));
      await load();
    } catch (failure) {
      if (sequence === workspaceSequence.current)
        setError((failure as { message?: string })?.message ?? t("research.agent_backend.save_failed"));
    } finally {
      if (sequence === workspaceSequence.current) setBusy(false);
    }
  }, [baseUrl, connection?.has_credential, load, system, t, token, workspaceSlug]);

  const test = useCallback(async () => {
    const sequence = workspaceSequence.current;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await agentService.testBackendConnection(workspaceSlug, system);
      if (sequence !== workspaceSequence.current) return;
      setStatus(
        result.ok
          ? system === "SYNLORA"
            ? t("research.agent_backend.cloud_test_ok")
            : t("research.agent_backend.test_ok", { count: String(result.models ?? 0) })
          : t("research.agent_backend.test_failed", { error: result.error ?? "" })
      );
      await load();
    } catch (failure) {
      if (sequence === workspaceSequence.current)
        setError((failure as { message?: string })?.message ?? t("research.agent_backend.test_failed_generic"));
    } finally {
      if (sequence === workspaceSequence.current) setBusy(false);
    }
  }, [load, system, t, workspaceSlug]);

  const remove = useCallback(async () => {
    const sequence = workspaceSequence.current;
    setBusy(true);
    setError("");
    try {
      await agentService.deleteBackendConnection(workspaceSlug, system);
      if (sequence !== workspaceSequence.current) return;
      setStatus(t("research.agent_backend.removed"));
      await load();
    } catch {
      if (sequence === workspaceSequence.current) setError(t("research.agent_backend.remove_failed"));
    } finally {
      if (sequence === workspaceSequence.current) setBusy(false);
    }
  }, [load, system, t, workspaceSlug]);

  if (loading && !hasLoaded) return <p className="text-12 text-tertiary">{t("research.common.loading")}</p>;

  return (
    <section className="max-w-2xl space-y-4">
      <div className="border-y border-subtle py-3 text-12 text-secondary">
        <p>{t("research.agent_backend.workspace", { name: workspaceName })}</p>
        <p className="mt-2">{t("research.agent_backend.default_runtime")}</p>
        {system === "SCIENCE_DISCOVERY" && !governanceEnabled && (
          <p className="mt-2 text-danger-primary">{t("research.agent_backend.governance_off_new_sessions")}</p>
        )}
      </div>
      <label className="flex flex-col gap-1 text-11 text-secondary">
        {t("research.agent_backend.system")}
        <select
          value={system}
          onChange={(changeEvent) => setSystem(changeEvent.target.value as "SCIENCE_DISCOVERY" | "SYNLORA")}
          className="focus:border-accent-primary rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary outline-none"
        >
          <option value="SCIENCE_DISCOVERY">{t("research.agent_backend.system_local")}</option>
          <option value="SYNLORA">{t("research.agent_backend.system_cloud")}</option>
        </select>
        <span className="text-11 text-tertiary">{t("research.agent_backend.system_hint")}</span>
      </label>
      {system === "SCIENCE_DISCOVERY" && (
        <label className="flex flex-col gap-1 text-11 text-secondary">
          {t("research.agent_backend.base_url")}
          <input
            value={baseUrl}
            onChange={(changeEvent) => setBaseUrl(changeEvent.target.value)}
            placeholder={t("research.agent_backend.base_url_placeholder")}
            className="focus:border-accent-primary rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary outline-none"
          />
          <span className="text-11 text-tertiary">{t("research.agent_backend.server_address_hint")}</span>
        </label>
      )}
      <label className="flex flex-col gap-1 text-11 text-secondary">
        {t("research.agent_backend.token")}
        <input
          type="password"
          value={token}
          onChange={(changeEvent) => setToken(changeEvent.target.value)}
          placeholder={connection?.has_credential ? t("research.agent_backend.token_kept") : ""}
          className="focus:border-accent-primary rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary outline-none"
        />
        {system === "SYNLORA" && (
          <span className="text-11 text-tertiary">{t("research.agent_backend.cloud_address_hint")}</span>
        )}
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || (system === "SCIENCE_DISCOVERY" && !baseUrl.trim())}
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
