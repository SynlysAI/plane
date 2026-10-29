import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import browserConfig from "./vite.config";

const browserFixtureDir = path.dirname(fileURLToPath(import.meta.url));
const planeRoot = path.resolve(browserFixtureDir, "../../../..");

export default mergeConfig(
  browserConfig,
  defineConfig({
    resolve: {
      alias: [
        {
          find: "@plane/utils",
          replacement: path.join(planeRoot, "packages/utils/src/common.ts"),
        },
      ],
    },
  })
);
