import { defineConfig } from "vite";
import fixtureConfig from "./vite.config";

/** 使用独立端口与缓存提供 MCP 界面预览。 */
export default defineConfig({
  ...fixtureConfig,
  cacheDir: "node_modules/.vite-mcp-settings",
  server: { ...fixtureConfig.server, port: 4197 },
});
