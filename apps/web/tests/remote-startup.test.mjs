import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(webRoot, "package.json"), "utf8"));

describe("remote web startup", () => {
  it("serves the optimized production preview on the default dev port", () => {
    assert.match(packageJson.scripts.dev, /react-router build/);
    assert.match(packageJson.scripts.dev, /vite preview/);
    assert.match(packageJson.scripts.dev, /--port 3000/);
    assert.match(packageJson.scripts.dev, /--strictPort/);
  });

  it("keeps local HMR available as a separate command", () => {
    assert.match(packageJson.scripts["dev:hmr"], /react-router dev/);
    assert.match(packageJson.scripts["dev:hmr"], /--port 3000/);
  });

  it("uses Vite preview for API proxy and compressed assets", () => {
    assert.match(packageJson.scripts.preview, /vite preview/);
    assert.doesNotMatch(packageJson.scripts.preview, /serve -s/);
  });
});
