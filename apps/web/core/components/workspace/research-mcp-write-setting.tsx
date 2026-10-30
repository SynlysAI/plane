import { useEffect, useState } from "react";
import type { TWorkspaceResearchSetting } from "@plane/types";
import { useResearch } from "@/hooks/store/use-research";

type Props = {
  workspaceSlug: string;
  researchEnabled: boolean;
  canConfigure: boolean;
};

/** Convert a research settings API error into a concise Chinese message. */
function settingError(error: unknown) {
  const value = error as { message?: string; detail?: string };
  return value?.message ?? value?.detail ?? "保存失败，请稍后重试。";
}

/** Workspace-level switch for controlled research MCP writes. */
export function WorkspaceResearchMCPWriteSetting({ workspaceSlug, researchEnabled, canConfigure }: Props) {
  const { fetchSettings, updateSettings } = useResearch();
  const [settings, setSettings] = useState<TWorkspaceResearchSetting | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    setError(null);
    setLoading(false);
    if (!researchEnabled || !canConfigure) return;

    setLoading(true);
    void (async () => {
      try {
        const value = await fetchSettings(workspaceSlug);
        if (cancelled) return;
        if (value) setSettings(value);
        else setError("科研 MCP 配置加载失败，请刷新重试。");
      } catch {
        if (!cancelled) setError("科研 MCP 配置加载失败，请刷新重试。");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [canConfigure, fetchSettings, researchEnabled, workspaceSlug]);

  const globallyAvailable = settings?.research_mcp_write_available !== false;
  const disabled = loading || saving || !researchEnabled || !canConfigure || !settings || !globallyAvailable;
  const statusId = "research-mcp-write-setting-status";
  const status = loading
    ? "正在加载配置…"
    : !researchEnabled
      ? "先开启科研模块后才能配置。"
      : !canConfigure
        ? "当前账号没有科研配置权限。"
        : !settings
          ? "科研 MCP 配置尚未加载。"
          : !globallyAvailable
            ? "服务器全局科研 MCP 读写开关未开启，请联系管理员。"
            : saving
              ? "正在保存…"
              : "开启后可为科研链节点签发受控写入连接；实际读写仍需服务器全局开关允许。";

  return (
    <section className="space-y-4 border-t border-subtle pt-7" aria-label="科研 MCP 写入">
      <h2 className="text-16 font-medium">科研 MCP 写入</h2>
      <p className="text-13 text-secondary">
        此开关只控制当前工作区。节点级授权、动态范围和写入操作仍按现有安全规则校验。
      </p>
      <label className="flex items-center gap-2 text-13">
        <input
          name="research-mcp-write-enabled"
          type="checkbox"
          checked={Boolean(settings?.research_mcp_write_enabled)}
          disabled={disabled}
          aria-describedby={statusId}
          onChange={(event) => {
            const enabled = event.target.checked;
            void (async () => {
              setSaving(true);
              setError(null);
              try {
                const value = await updateSettings(workspaceSlug, { research_mcp_write_enabled: enabled });
                setSettings(value);
              } catch (cause) {
                setError(settingError(cause));
              } finally {
                setSaving(false);
              }
            })();
          }}
        />
        允许工作区科研 MCP 受控写入
      </label>
      <p id={statusId} className="text-12 text-secondary" role={loading ? "status" : undefined}>
        {status}
      </p>
      {error && (
        <p role="alert" className="text-13 text-danger-primary">
          {error}
        </p>
      )}
    </section>
  );
}
