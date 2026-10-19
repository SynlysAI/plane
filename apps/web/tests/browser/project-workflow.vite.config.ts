import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import fixtureConfig from "./vite.config";

export default defineConfig({
  ...fixtureConfig,
  cacheDir: "node_modules/.vite-project-workflow",
  resolve: {
    ...fixtureConfig.resolve,
    alias: {
      "@/helpers": fileURLToPath(new URL("../../helpers", import.meta.url)),
      "@/app": fileURLToPath(new URL("../../app", import.meta.url)),
      ...(fixtureConfig.resolve?.alias as Record<string, string>),
    },
  },
});
