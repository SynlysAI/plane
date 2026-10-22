import path from "node:path";
import fs from "node:fs";
import * as dotenv from "dotenv";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

dotenv.config({ path: path.resolve(__dirname, ".env") });

// Backend targets for the dev-server proxy. Keeping the browser on the same
// origin lets the app work no matter which host/IP/hostname it is opened from.
const apiProxyTarget = process.env.API_PROXY_TARGET || "http://localhost:8001";
const liveProxyTarget = process.env.LIVE_PROXY_TARGET || "http://localhost:3100";
// Object storage (MinIO/S3) target. Assets are uploaded straight from the
// browser with a presigned POST, so routing that traffic through this origin
// means the browser only ever needs to reach the port the app is served on —
// no second port, no CORS hop, no cross-origin firewall/proxy surprises.
const storageProxyTarget = process.env.STORAGE_PROXY_TARGET || "http://localhost:9000";

// Django builds its redirects from the configured WEB_URL, so a browser that
// opened the app through another host (LAN IP, Tailscale name) would be sent to
// a host it cannot reach — after sign-out or a failed sign-in, for example.
// Rewrite those redirects back to the origin the browser actually used. Only
// the configured base URLs are rewritten, so unrelated redirects (OAuth
// providers and the like) pass through untouched.
const redirectBaseUrls = [process.env.VITE_WEB_BASE_URL].map((url) => (url || "").replace(/\/+$/, "")).filter(Boolean);

const rewriteRedirectHost: NonNullable<ProxyOptions["configure"]> = (proxy, _options) => {
  proxy.on("proxyRes", (proxyRes, req) => {
    const location = proxyRes.headers.location;
    const host = req.headers.host;
    if (!host || typeof location !== "string") return;
    const base = redirectBaseUrls.find((url) => location.startsWith(url));
    if (!base) return;
    const forwardedProto = req.headers["x-forwarded-proto"];
    let scheme = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
    if (!scheme) {
      const sourceHeader = req.headers.origin ?? req.headers.referer;
      const source = Array.isArray(sourceHeader) ? sourceHeader[0] : sourceHeader;
      try {
        scheme = source ? new URL(source).protocol.replace(":", "") : "http";
      } catch {
        scheme = "http";
      }
    }
    proxyRes.headers.location = `${scheme}://${host}${location.slice(base.length)}`;
  });
};

const proxy = {
  // Keep the Host header the browser used: Django compares the Origin of unsafe
  // requests (login form POSTs) with the request host, so rewriting Host to
  // localhost makes every other IP/hostname the app is opened from fail with
  // "CSRF Verification Failed".
  "/api": { target: apiProxyTarget, changeOrigin: false, configure: rewriteRedirectHost },
  "/auth": { target: apiProxyTarget, changeOrigin: false, configure: rewriteRedirectHost },
  // Same reason for keeping the Host header: presigned S3 GET urls are signed
  // against the browser-visible host, so rewriting it invalidates the signature.
  "/uploads": { target: storageProxyTarget, changeOrigin: false },
  "/live": { target: liveProxyTarget, changeOrigin: true, ws: true },
};

// Hosts the dev server answers to. Vite rejects requests whose Host header is
// not listed here, which blocks opening the app by name from another machine
// (LAN hostnames, Tailscale MagicDNS names such as *.ts.net). IP addresses are
// always allowed. Add more names with DEV_ALLOWED_HOSTS="foo,bar".
const allowedHosts = [
  "localhost",
  ".localhost",
  ".local",
  ".ts.net",
  ...(process.env.DEV_ALLOWED_HOSTS || "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean),
];

// Expose only vars starting with VITE_
const viteEnv = Object.keys(process.env)
  .filter((k) => k.startsWith("VITE_"))
  .reduce<Record<string, string>>((a, k) => {
    a[k] = process.env[k] ?? "";
    return a;
  }, {});

/**
 * 为远程访问提供最小访问日志与静态资源缓存策略。
 *
 * Returns:
 *     Vite 插件；仅影响 Preview 服务器，不改变构建产物。
 */
function previewRemoteDiagnostics(): Plugin {
  const accessLogEnabled = process.env.PLANE_PREVIEW_ACCESS_LOG === "1";

  return {
    name: "plane-preview-remote-diagnostics",
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url || "/", "http://localhost").pathname;
        if (pathname.startsWith("/assets/")) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
        if (!accessLogEnabled) {
          next();
          return;
        }

        const startedAt = Date.now();
        res.on("finish", () => {
          const remote = req.socket.remoteAddress || "-";
          const userAgent = req.headers["user-agent"] || "-";
          console.log(
            `[preview-access] ${new Date().toISOString()} ${remote} ${req.method} ${req.url} ${res.statusCode} ${Date.now() - startedAt}ms ${userAgent}`
          );
        });
        next();
      });
    },
  };
}

const PDF_JS_RESOURCES = [
  { route: "/pdfjs/cmaps/", source: path.resolve(__dirname, "node_modules/pdfjs-dist/cmaps") },
  { route: "/pdfjs/standard_fonts/", source: path.resolve(__dirname, "node_modules/pdfjs-dist/standard_fonts") },
  { route: "/pdfjs/wasm/", source: path.resolve(__dirname, "node_modules/pdfjs-dist/wasm") },
];

/**
 * 在开发和构建产物中提供 PDF.js 的本地 CMap、标准字体与 WASM 资源。
 *
 * 这些文件来自锁定版本的依赖包，不提交到仓库；构建时复制到静态输出目录，
 * 避免浏览器为渲染中文 PDF 向外部源发起请求。
 */
function localPdfResources(): Plugin {
  return {
    name: "plane-local-pdf-resources",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
        const resource = PDF_JS_RESOURCES.find((item) => pathname.startsWith(item.route));
        if (!resource) {
          next();
          return;
        }
        const relativePath = path.normalize(pathname.slice(resource.route.length));
        const filePath = path.resolve(resource.source, relativePath);
        if (
          !filePath.startsWith(resource.source + path.sep) ||
          !fs.existsSync(filePath) ||
          !fs.statSync(filePath).isFile()
        ) {
          next();
          return;
        }
        res.setHeader("Cache-Control", "public, max-age=86400");
        fs.createReadStream(filePath).pipe(res);
      });
    },
    closeBundle() {
      for (const resource of PDF_JS_RESOURCES) {
        const output = path.join(__dirname, "build/client", resource.route.replace(/^\/+/, ""));
        fs.cpSync(resource.source, output, { recursive: true });
      }
    },
  };
}

export default defineConfig(() => ({
  define: {
    "process.env": JSON.stringify(viteEnv),
  },
  build: {
    assetsInlineLimit: 0,
  },
  plugins: [
    reactRouter(),
    tsconfigPaths({ projects: [path.resolve(__dirname, "tsconfig.json")] }),
    previewRemoteDiagnostics(),
    localPdfResources(),
  ],
  resolve: {
    alias: {
      // Next.js compatibility shims used within web
      "next/link": path.resolve(__dirname, "app/compat/next/link.tsx"),
      "next/navigation": path.resolve(__dirname, "app/compat/next/navigation.ts"),
      "next/script": path.resolve(__dirname, "app/compat/next/script.tsx"),
    },
    dedupe: ["react", "react-dom", "@headlessui/react"],
  },
  server: {
    host: process.env.HOST || "127.0.0.1",
    allowedHosts,
    proxy,
  },
  preview: {
    host: process.env.HOST || "127.0.0.1",
    allowedHosts,
    proxy,
  },
  // No SSR-specific overrides needed; alias resolves to ESM build
}));
