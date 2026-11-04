import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

const browserFixtureDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(browserFixtureDir, "../..");

/** 右侧三栏停靠布局浏览器验收配置。 */
export default defineConfig({
  root: browserFixtureDir,
  cacheDir: "node_modules/.vite-right-dock-layout",
  define: {
    "process.env": JSON.stringify({}),
  },
  plugins: [tsconfigPaths({ projects: [path.join(webRoot, "tsconfig.json")] })],
  css: {
    postcss: path.join(webRoot, "postcss.config.js"),
  },
  resolve: {
    alias: {
      "@/services/research/chain-task.service": path.join(browserFixtureDir, "right-dock-layout.chain-task.service.ts"),
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
    port: 4187,
    strictPort: true,
    watch: null,
  },
});
