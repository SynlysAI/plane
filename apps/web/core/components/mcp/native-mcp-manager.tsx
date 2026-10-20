import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@plane/propel/button";
import {
  NativeMCPService,
  type TNativeOptions,
  type TNativeSession,
  type TNativeToken,
  type TNativeConnection,
} from "@/services/mcp.service";

const service = new NativeMCPService();
const inputClass = "rounded border border-subtle bg-surface-1 px-3 py-2";

export function NativeMCPManager({ workspaceSlug }: { workspaceSlug: string }) {
  const [options, setOptions] = useState<TNativeOptions | null>(null);
  const [session, setSession] = useState<TNativeSession | null>(null);
  const [tokens, setTokens] = useState<TNativeToken[]>([]);
  const [connection, setConnection] = useState<TNativeConnection | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("我的 Agent");
  const [days, setDays] = useState(30);
  const [publish, setPublish] = useState(false);
  const [nativeWorkspace, setNativeWorkspace] = useState("");
  const tokenInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const invalidate = useCallback(() => {
    generation.current += 1;
  }, []);

  useEffect(() => {
    const expected = ++generation.current;
    setConnection(null);
    setSession(null);
    setOptions(null);
    setTokens([]);
    setError("");
    setNotice("");
    setPublish(false);
    setNativeWorkspace("");
    setBusy(false);
    void (async () => {
      const next = await service.read<TNativeOptions>("options");
      if (generation.current !== expected) return;
      setOptions(next);
      setNativeWorkspace(next.workspaces.includes(workspaceSlug) ? workspaceSlug : "");
      setDays(Math.min(30, next.max_token_days));
      try {
        const current = await service.read<TNativeSession>("session");
        const listing = await service.read<{ tokens: TNativeToken[] }>("tokens");
        if (generation.current === expected) {
          setSession(current);
          setTokens(listing.tokens);
        }
      } catch (failure) {
        if ((failure as { status?: number }).status !== 401) throw failure;
      }
    })().catch((failure: { message?: string }) => {
      if (generation.current === expected) setError(failure.message || "行政接入服务暂不可用。");
    });
    return () => {
      invalidate();
    };
  }, [workspaceSlug, invalidate]);

  async function run(action: string, data: Record<string, unknown>) {
    if (!options || busy || !options.workspaces.includes(nativeWorkspace)) return;
    const expected = generation.current;
    setBusy(true);
    setError("");
    setNotice("");
    // Native keys are never React state, URL parameters, or persistent storage.
    if (tokenInput.current) tokenInput.current.value = "";
    try {
      const result = await service.write<TNativeConnection & TNativeSession>(
        action,
        data,
        options.csrf_token,
        session?.csrf ?? ""
      );
      if (generation.current !== expected) return;
      if (action === "logout") {
        setSession(null);
        setConnection(null);
        setTokens([]);
        return;
      }
      if (action === "login") setSession(result);
      if (action === "tokens") {
        setConnection(result);
        setNotice("连接已生成，请保存到本机私密配置。");
      }
      if (action.endsWith("/revoke")) {
        setConnection(null);
        setNotice("连接已撤销。");
      }
      const listing = await service.read<{ tokens: TNativeToken[] }>("tokens");
      if (generation.current === expected) setTokens(listing.tokens);
    } catch (failure) {
      if (generation.current !== expected) return;
      const problem = failure as { status?: number; message?: string };
      if (problem.status === 401) {
        setSession(null);
        setConnection(null);
        setTokens([]);
      }
      setError(problem.message || "操作失败，请核对后重试。");
    } finally {
      if (generation.current === expected) setBusy(false);
    }
  }

  return (
    <section aria-label="行政项目接入" className="space-y-4">
      <p className="text-secondary">
        读取行政项目的工作项、状态与评论，沿用 Plane 原生项目/工作项 API；科研链数据请使用后端科研 MCP API。
        个人令牌仅用于行政服务身份验证；服务开放发布时，才可准备并发布工作项进展评论。
      </p>
      {error && (
        <p role="alert" className="text-danger-primary">
          {error}
        </p>
      )}
      {!options && !error && <p role="status">正在读取接入服务配置…</p>}
      {options && (
        <>
          <p>
            当前服务：{options.allow_publish ? "允许选择进展评论发布" : "只读，未开放评论发布"} · 连接最长{" "}
            {options.max_token_days} 天
          </p>
          {options.plane_ui_url && <p className="text-secondary">行政项目所属 Plane：{options.plane_ui_url}</p>}
          {!options.workspaces.includes(workspaceSlug) && (
            <p role="status">此服务尚未开放当前工作区。请选择行政服务允许的目标工作区；访问权限仍由个人令牌验证。</p>
          )}
          <label className="flex max-w-md flex-col gap-1">
            行政服务目标工作区
            <select
              aria-label="行政服务目标工作区"
              className={inputClass}
              value={nativeWorkspace}
              disabled={busy}
              onChange={(event) => {
                invalidate();
                setNativeWorkspace(event.target.value);
                setConnection(null);
                setPublish(false);
                setNotice("");
                setError("");
                if (tokenInput.current) tokenInput.current.value = "";
              }}
            >
              <option value="">请选择目标工作区</option>
              {options.workspaces.map((workspace) => (
                <option key={workspace} value={workspace}>
                  {workspace}
                </option>
              ))}
            </select>
          </label>
          {options.workspaces.includes(nativeWorkspace) && (
            <>
              {!session ? (
                <form
                  className="flex flex-wrap items-end gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const plane_token = tokenInput.current?.value.trim();
                    if (plane_token) void run("login", { plane_token });
                  }}
                >
                  <label className="flex flex-col gap-1">
                    Plane 个人 API Token
                    <input
                      ref={tokenInput}
                      className={inputClass}
                      type="password"
                      required
                      autoComplete="off"
                      maxLength={4096}
                    />
                  </label>
                  <Button type="submit" disabled={busy}>
                    验证行政项目身份
                  </Button>
                  <a
                    className="text-accent-primary"
                    href={`${options.plane_ui_url?.replace(/\/+$/, "") ?? ""}/settings/profile/api-tokens/`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    管理个人令牌
                  </a>
                </form>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-3">
                    <p>已验证行政服务账号：{session.name}</p>
                    <Button variant="secondary" disabled={busy} onClick={() => void run("logout", {})}>
                      退出行政接入
                    </Button>
                  </div>
                  <form
                    className="flex flex-wrap items-end gap-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void run("tokens", {
                        workspace: nativeWorkspace,
                        label: label.trim(),
                        days,
                        publish: options.allow_publish && publish,
                      });
                    }}
                  >
                    <label className="flex flex-col gap-1">
                      连接名称
                      <input
                        className={inputClass}
                        value={label}
                        maxLength={64}
                        required
                        onChange={(event) => setLabel(event.target.value)}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      有效天数
                      <input
                        className={inputClass}
                        type="number"
                        min={1}
                        max={options.max_token_days}
                        value={days}
                        required
                        onChange={(event) => setDays(Number(event.target.value))}
                      />
                    </label>
                    {options.allow_publish && (
                      <label>
                        <input
                          type="checkbox"
                          checked={publish}
                          onChange={(event) => setPublish(event.target.checked)}
                        />{" "}
                        允许行政项目进展评论发布
                      </label>
                    )}
                    <Button type="submit" disabled={busy || !label.trim()}>
                      生成行政项目连接
                    </Button>
                  </form>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      const expected = generation.current;
                      setError("");
                      void service
                        .read<{ tokens: TNativeToken[] }>("tokens")
                        .then((listing) => {
                          if (generation.current === expected) setTokens(listing.tokens);
                          return listing;
                        })
                        .catch(() => {
                          if (generation.current === expected) setError("刷新失败，请重新验证身份。");
                        });
                    }}
                  >
                    刷新行政连接
                  </Button>
                  {tokens
                    .filter((token) => token.workspace === nativeWorkspace)
                    .map((token) => (
                      <div
                        key={token.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded border border-subtle p-3"
                      >
                        <p>
                          {token.label} ·{" "}
                          {token.revoked
                            ? "已撤销"
                            : token.expires * 1000 <= Date.now()
                              ? "已到期"
                              : token.publish
                                ? "读取与进展发布"
                                : "只读"}{" "}
                          · 到期 {new Date(token.expires * 1000).toLocaleString()}
                        </p>
                        {!token.revoked && token.expires * 1000 > Date.now() && (
                          <Button
                            variant="secondary"
                            disabled={busy}
                            onClick={() => void run(`tokens/${token.id}/revoke`, {})}
                          >
                            撤销行政连接：{token.label}
                          </Button>
                        )}
                      </div>
                    ))}
                </>
              )}
            </>
          )}
          {notice && <p role="status">{notice}</p>}
          {connection && (
            <div className="space-y-2">
              <p>Bearer 密钥仅本次展示，离开页面后无法再次查看。</p>
              <label className="block">
                Codex 配置
                <textarea
                  aria-label="行政项目 Codex 配置"
                  readOnly
                  className="font-mono h-40 w-full rounded border border-subtle p-3 text-12"
                  value={connection.codex_toml}
                />
              </label>
              <label className="block">
                通用 MCP JSON 配置
                <textarea
                  aria-label="行政项目 JSON 配置"
                  readOnly
                  className="font-mono h-40 w-full rounded border border-subtle p-3 text-12"
                  value={connection.sciencediscovery_json}
                />
              </label>
              <Button variant="secondary" onClick={() => setConnection(null)}>
                隐藏行政连接密钥
              </Button>
            </div>
          )}
          <a className="text-accent-primary" href={options.portal_url} target="_blank" rel="noreferrer">
            打开兼容自助接入页
          </a>
        </>
      )}
    </section>
  );
}
