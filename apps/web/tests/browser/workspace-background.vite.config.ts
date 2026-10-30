import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import fixtureConfig from "./vite.config";

/** 独立缓存与端口，避免干扰正在运行的应用预览。 */
export default defineConfig({
  ...fixtureConfig,
  cacheDir: "node_modules/.vite-workspace-background",
  resolve: {
    ...fixtureConfig.resolve,
    alias: {
      "@/helpers": fileURLToPath(new URL("../../helpers", import.meta.url)),
      "@/app": fileURLToPath(new URL("../../app", import.meta.url)),
      "@/styles": fileURLToPath(new URL("../../styles", import.meta.url)),
      ...(fixtureConfig.resolve?.alias as Record<string, string>),
    },
  },
  server: { ...fixtureConfig.server, port: 4191 },
});
