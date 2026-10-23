import { defineConfig } from "vite";

import fixtureConfig from "./vite.config";

export default defineConfig({
  ...fixtureConfig,
  cacheDir: "node_modules/.vite-research-chain-stage-approval",
  server: { ...fixtureConfig.server, port: 4185, watch: null },
});
