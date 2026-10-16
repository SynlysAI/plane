import { defineConfig } from "vite";
import fixtureConfig from "./vite.config";

export default defineConfig({
  ...fixtureConfig,
  cacheDir: "node_modules/.vite-assistant-panel",
  server: { ...fixtureConfig.server, port: 4176, watch: null },
});
