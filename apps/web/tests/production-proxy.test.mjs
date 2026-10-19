import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const caddyBinary = process.env.CADDY_BINARY || "caddy";
const hasCaddy = spawnSync(caddyBinary, ["version"]).status === 0;
const configPath = fileURLToPath(new URL("../caddy/Caddyfile.prod", import.meta.url));

/**
 * 向本地代理发送请求，并保留指定的浏览器 Host。
 * @param {number} port 本地代理端口。
 * @param {string} path 请求路径。
 * @param {string} host 浏览器发送的完整 Host。
 * @returns {Promise<string>} 上游响应正文。
 */
function proxyRequest(port, path, host) {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port, path, method: "POST", headers: { Host: host, Connection: "close" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      }
    );
    req.on("error", reject);
    req.setTimeout(1000, () => req.destroy(new Error("代理请求超时")));
    req.end();
  });
}

test("生产代理在 API、认证和存储请求中保留浏览器 Host 与端口", { skip: !hasCaddy, timeout: 15000 }, async (t) => {
  const upstream = createServer((req, res) => res.end(`http://${req.headers.host}/uploads/`));
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => {
    upstream.closeAllConnections();
    return new Promise((resolve) => upstream.close(resolve));
  });
  const upstreamPort = upstream.address().port;

  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const proxyPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));

  const adapted = spawnSync(caddyBinary, ["adapt", "--config", configPath], { encoding: "utf8" });
  assert.equal(adapted.status, 0, adapted.stderr);
  // 使用真实生产路由，仅替换监听地址和上游，避免依赖生产网络与数据库。
  const config = JSON.parse(adapted.stdout);
  config.admin = { disabled: true };
  const isolatedConfig = JSON.stringify(config, (key, value) => {
    if (key === "listen") return [`127.0.0.1:${proxyPort}`];
    if (key === "dial") return `127.0.0.1:${upstreamPort}`;
    return value;
  });
  const directory = mkdtempSync(join(tmpdir(), "plane-production-proxy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const isolatedConfigPath = join(directory, "caddy.json");
  writeFileSync(isolatedConfigPath, isolatedConfig);
  const caddy = spawn(caddyBinary, ["run", "--config", isolatedConfigPath], { stdio: ["ignore", "ignore", "pipe"] });
  let logs = "";
  caddy.stderr.on("data", (chunk) => (logs += chunk));
  t.after(async () => {
    if (caddy.exitCode !== null) return;
    const exited = once(caddy, "exit");
    caddy.kill();
    await exited;
  });

  const readyDeadline = Date.now() + 5000;
  // 启动探测依赖前一次连接结果，必须按顺序重试。
  while (true) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await proxyRequest(proxyPort, "/api/instances/", "localhost");
      break;
    } catch {
      assert.equal(caddy.exitCode, null, logs);
      assert.ok(Date.now() < readyDeadline, logs);
      // eslint-disable-next-line no-await-in-loop
      await delay(25);
    }
  }

  const checks = [];
  for (const host of ["10.26.15.92:3300", "plane.example.test:3300", "[::1]:3300", "plane.example.test"]) {
    for (const path of ["/api/assets/v2/workspaces/public/", "/auth/sign-in/", "/uploads", "/uploads/"]) {
      checks.push(
        proxyRequest(proxyPort, path, host).then((url) =>
          assert.equal(url, `http://${host}/uploads/`, `${host} ${path}`)
        )
      );
    }
  }
  await Promise.all(checks);
});
