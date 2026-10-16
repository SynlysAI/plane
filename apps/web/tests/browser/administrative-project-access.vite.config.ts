import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import fixtureConfig from "./vite.config";

// 独立依赖缓存避免与运行中的应用开发服务器相互覆盖。
export default defineConfig({
  ...fixtureConfig,
  cacheDir: "node_modules/.vite-administrative-access",
  resolve: {
    ...fixtureConfig.resolve,
    alias: {
      "@/helpers": fileURLToPath(new URL("../../helpers", import.meta.url)),
      "@/app": fileURLToPath(new URL("../../app", import.meta.url)),
      "@/styles": fileURLToPath(new URL("../../styles", import.meta.url)),
      ...(fixtureConfig.resolve?.alias as Record<string, string>),
    },
  },
  server: { ...fixtureConfig.server, port: 4182 },
});
