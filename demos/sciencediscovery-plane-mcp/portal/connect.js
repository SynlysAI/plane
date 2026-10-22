/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

"use strict";
const $ = (id) => document.getElementById(id);
let csrf = "";
let generated = null;

function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
  $("notice").hidden = false;
}

async function api(path, data) {
  const headers = {};
  const options = { credentials: "same-origin", headers };
  if (data !== undefined) {
    options.method = "POST";
    headers["Content-Type"] = "application/json";
    if (csrf) headers["X-MCP-CSRF"] = csrf;
    options.body = JSON.stringify(data);
  }
  const response = await fetch("/connect/api/" + path, options);
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== "login") signedOut();
    throw new Error(result.error || "请求失败，请稍后重试。");
  }
  return result;
}

function signedIn(session) {
  csrf = session.csrf;
  $("account-name").textContent = session.name;
  $("login-card").hidden = true;
  $("account-area").hidden = false;
}

function signedOut() {
  csrf = "";
  generated = null;
  $("codex-config").value = "";
  $("science-config").value = "";
  $("result-card").hidden = true;
  $("account-area").hidden = true;
  $("login-card").hidden = false;
}

async function refresh() {
  const result = await api("tokens");
  const root = $("connections");
  root.replaceChildren();
  if (!result.tokens.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "还没有个人连接。创建一个，开始使用你的 Agent。";
    root.append(empty);
  }
  for (const item of result.tokens) {
    const row = document.createElement("div");
    row.className = "connection";
    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "connection-name";
    name.textContent = item.label;
    const expired = item.expires * 1000 <= Date.now();
    const inactive = item.revoked || expired;
    const badge = document.createElement("span");
    badge.className = "badge" + (inactive ? " inactive" : "");
    badge.textContent = item.revoked ? "已撤销" : expired ? "已过期" : item.publish ? "读取与进展发布" : "只读";
    name.append(badge);
    const detail = document.createElement("p");
    detail.textContent = "工作区 " + item.workspace + " · 到期 " + new Date(item.expires * 1000).toLocaleString();
    info.append(name, detail);
    row.append(info);
    if (!inactive) {
      const revoke = document.createElement("button");
      revoke.className = "quiet revoke";
      revoke.textContent = "撤销";
      revoke.setAttribute("aria-label", "撤销连接：" + item.label);
      revoke.addEventListener("click", async () => {
        revoke.disabled = true;
        try {
          await api("tokens/" + encodeURIComponent(item.id) + "/revoke", {});
          if (generated && generated.id === item.id) {
            generated = null;
            $("codex-config").value = "";
            $("science-config").value = "";
            $("result-card").hidden = true;
          }
          notice("连接已撤销，新的 Agent 请求将不再通过认证。");
          await refresh();
        } catch (error) {
          notice(error.message, true);
          revoke.disabled = false;
        }
      });
      row.append(revoke);
    }
    root.append(row);
  }
}

async function busy(form, action) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await action();
  } catch (error) {
    notice(error.message, true);
  } finally {
    button.disabled = false;
  }
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await busy(event.currentTarget, async () => {
    let session;
    try {
      session = await api("login", { plane_token: $("plane-token").value.trim() });
    } finally {
      $("plane-token").value = "";
    }
    signedIn(session);
    notice("账号验证成功。现在可以创建自己的 Agent 连接。");
    await refresh();
  });
});

$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await busy(event.currentTarget, async () => {
    generated = await api("tokens", {
      workspace: $("workspace").value,
      label: $("connection-name").value.trim(),
      days: Number($("days").value),
      publish: $("publish").checked,
    });
    $("codex-config").value = generated.codex_toml;
    $("science-config").value = generated.sciencediscovery_json;
    $("result-card").hidden = false;
    notice("连接配置已生成。请现在复制或下载，离开页面后无法再次查看完整令牌。");
    await refresh();
    $("result-card").scrollIntoView({ behavior: "smooth", block: "start" });
  });
});

async function copy(id) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText($(id).value);
    else {
      $(id).focus();
      $(id).select();
      if (!document.execCommand("copy")) throw new Error();
    }
    notice("配置已复制。请只保存到自己的客户端配置中。");
  } catch {
    notice("请选中配置内容并手动复制。", true);
  }
}

function download(id, filename, type) {
  const url = URL.createObjectURL(new Blob([$(id).value], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("copy-codex").addEventListener("click", () => copy("codex-config"));
$("copy-science").addEventListener("click", () => copy("science-config"));
$("download-codex").addEventListener("click", () => download("codex-config", "plane-mcp.private.toml", "text/plain"));
$("download-science").addEventListener("click", () =>
  download("science-config", "plane-mcp.private.json", "application/json")
);
$("refresh").addEventListener("click", () => refresh().catch((error) => notice(error.message, true)));
$("logout").addEventListener("click", async () => {
  try {
    await api("logout", {});
    location.reload();
  } catch (error) {
    notice(error.message, true);
  }
});

async function start() {
  const options = await api("options");
  $("plane-settings").href = options.plane_ui_url + "/settings/profile/api-tokens/";
  $("unified-settings").href = options.plane_ui_url + "/settings/profile/mcp/";
  for (const workspace of options.workspaces) $("workspace").add(new Option(workspace, workspace));
  const days = [...new Set([1, 7, 30, 90, options.max_token_days])]
    .filter((n) => n <= options.max_token_days)
    .toSorted((a, b) => a - b);
  for (const day of days) $("days").add(new Option(day + " 天", day));
  $("days").value = Math.min(30, options.max_token_days);
  $("publish-option").hidden = !options.allow_publish;
  try {
    signedIn(await api("session"));
    await refresh();
  } catch {
    /* First visit or expired portal session. */
  }
}
start().catch((error) => notice(error.message, true));
