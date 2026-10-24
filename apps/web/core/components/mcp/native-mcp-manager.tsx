/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@plane/propel/button";
import { failureMessage } from "./connection-config";
import { emptyNative, nativeService, loadNativeState, type NativeState } from "./mcp-services";

/** Independent portal identity. Targets live in the unified workspace tree. */
export function NativeMCPManager({
  state,
  onChange,
  onInvalidate,
  refreshVersion,
  disabled,
}: {
  state: NativeState;
  onChange: (state: NativeState) => void;
  onInvalidate: () => void;
  refreshVersion: number;
  disabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const epoch = useRef(0);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const latest = useRef(state);
  const change = useRef(onChange);
  useLayoutEffect(() => {
    latest.current = state;
    change.current = onChange;
  }, [state, onChange]);
  const [browserOrigin, setBrowserOrigin] = useState<string | null>(null);
  useEffect(() => setBrowserOrigin(window.location.origin), []);
  useEffect(() => {
    const expected = ++epoch.current;
    setBusy(true);
    setError("");
    void loadNativeState()
      .then(({ state: loaded, message: feedback }) => {
        if (epoch.current !== expected) return;
        setError(feedback);
        return change.current(loaded);
      })
      .catch((error) => {
        if (epoch.current === expected) {
          setError(failureMessage(error));
          change.current(emptyNative);
        }
      })
      .finally(() => {
        if (epoch.current === expected) setBusy(false);
      });
    return () => {
      epoch.current += 1;
    };
  }, [retry, refreshVersion]);

  async function authenticate(logout: boolean) {
    if (!state.options || pending.current) return;
    const pat = input.current?.value.trim();
    if (!logout && !pat) return;
    if (input.current) input.current.value = "";
    pending.current = true;
    setBusy(true);
    setError("");
    const expected = ++epoch.current;
    onInvalidate();
    if (logout) onChange({ ...state, session: null, candidates: null, tokens: [] });
    try {
      await nativeService.write(
        logout ? "logout" : "login",
        logout ? {} : { plane_token: pat },
        state.options.csrf_token,
        state.session?.csrf ?? ""
      );
      if (epoch.current === expected) setRetry((value) => value + 1);
    } catch (error) {
      if (epoch.current === expected) {
        setError(failureMessage(error));
        if (!logout) onChange({ ...latest.current, session: null, candidates: null, tokens: [] });
      }
    } finally {
      pending.current = false;
      if (epoch.current === expected) setBusy(false);
    }
  }
  return (
    <NativeMCPIdentity
      state={state}
      browserOrigin={browserOrigin}
      input={input}
      busy={busy}
      disabled={disabled}
      message={message}
      onAuthenticate={authenticate}
      onRefresh={() => {
        onInvalidate();
        setRetry((value) => value + 1);
      }}
    />
  );
}

function NativeMCPIdentity({
  state,
  browserOrigin,
  input,
  busy,
  disabled,
  message,
  onAuthenticate,
  onRefresh,
}: {
  state: NativeState;
  browserOrigin: string | null;
  input: RefObject<HTMLInputElement | null>;
  busy: boolean;
  disabled: boolean;
  message: string;
  onAuthenticate: (logout: boolean) => Promise<void>;
  onRefresh: () => void;
}) {
  const origin = state.options?.plane_ui_url?.replace(/\/+$/, "");
  return (
    <section aria-label="行政身份验证" className="space-y-3 rounded border border-subtle p-4">
      <h3 className="text-16 font-semibold">行政项目接入 · 独立门户身份</h3>
      <NativeMCPSource origin={origin} browserOrigin={browserOrigin} />
      {busy && <p role="status">正在验证或加载行政接入…</p>}
      {message && (
        <p role="alert" className="text-danger-primary">
          {message}
        </p>
      )}
      <Button variant="secondary" disabled={busy || disabled} onClick={onRefresh}>
        刷新行政接入
      </Button>
      {state.options &&
        (state.session ? (
          <div className="flex flex-wrap items-center gap-3">
            <p>已验证行政服务账号：{state.session.name}</p>
            <Button variant="secondary" disabled={busy || disabled} onClick={() => void onAuthenticate(true)}>
              退出行政接入
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void onAuthenticate(false);
            }}
          >
            <label>
              Plane 个人 API Token
              <input
                ref={input}
                aria-label="行政个人令牌"
                className="ml-2 rounded border border-subtle bg-surface-1 p-2"
                type="password"
                autoComplete="off"
                maxLength={1024}
                required
              />
            </label>
            <Button type="submit" disabled={busy || disabled}>
              验证行政项目身份
            </Button>
            <a
              className="text-accent-primary"
              href={`${origin ?? ""}/settings/profile/api-tokens/`}
              target="_blank"
              rel="noreferrer"
            >
              管理此来源的个人令牌
            </a>
          </form>
        ))}
      {state.candidates?.failures.map((failure) => (
        <p role="alert" key={failure.workspace}>
          {failure.workspace}：{failure.error}；请刷新重试。
        </p>
      ))}
      {state.session && state.candidates && state.candidates.workspaces.length === 0 && (
        <p>此身份没有可接入的已开放行政工作区。</p>
      )}
      {state.options && (
        <p className="text-secondary">
          连接最长 {state.options.max_token_days} 天；
          {state.options.allow_publish ? "可选择读取与进展评论发布" : "管理员仅开放读取"}。
        </p>
      )}
    </section>
  );
}

function NativeMCPSource({ origin, browserOrigin }: { origin: string | undefined; browserOrigin: string | null }) {
  if (!origin) return null;
  return (
    <p>
      来源：{origin} ·{" "}
      {browserOrigin === null
        ? "正在确认来源"
        : origin === browserOrigin
          ? "同一 Plane 实例"
          : "独立 Plane 来源（可能为另一实例）"}
      。门户账号独立验证，不按工作区同名自动映射。
    </p>
  );
}
