import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

const browserFixtureDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(browserFixtureDir, "../..");

/** 科研链阶段审批浏览器夹具的独立 Vite 配置。 */
export default defineConfig({
  root: browserFixtureDir,
  cacheDir: "node_modules/.vite-research-chain-stage-approval",
  define: {
    "process.env": JSON.stringify({}),
  },
  plugins: [tsconfigPaths({ projects: [path.join(webRoot, "tsconfig.json")] })],
  css: {
    postcss: path.join(webRoot, "postcss.config.js"),
  },
  resolve: {
    alias: {
      "@/helpers": path.join(webRoot, "helpers"),
      "@/app": path.join(webRoot, "app"),
      "@": path.join(webRoot, "core"),
      "next/link": path.join(webRoot, "app/compat/next/link.tsx"),
      "next/navigation": path.join(webRoot, "app/compat/next/navigation.ts"),
    },
    dedupe: ["react", "react-dom", "@headlessui/react"],
  },
  server: {
    host: "127.0.0.1",
    port: 4185,
    strictPort: true,
    watch: null,
  },
});
