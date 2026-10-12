import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeSourceTexts,
  compareAuditToBaseline,
  hasDynamicI18nPrefix,
  parseArguments,
} from "../scripts/research-reference-audit.mjs";

const ROOT = "/research-reference-fixture";

const sources = {
  [`${ROOT}/apps/web/core/components/research/widget.tsx`]: `
    export type TWidgetState = "ready" | "error";
    export const useWidgetState = (): TWidgetState => "ready";
    export function Widget() {
      const state = useWidgetState();
      return state;
    }
  `,
  [`${ROOT}/apps/web/core/components/research/code/code-list.tsx`]: `
    export function CodeList() {}
  `,
  [`${ROOT}/apps/web/core/components/research/code/index.ts`]: `
    export { CodeList } from "./code-list";
  `,
  [`${ROOT}/apps/web/core/components/research/side-panel.tsx`]: `
    export function ResearchAgentSidePanel() {}
  `,
  [`${ROOT}/apps/web/core/components/research/compat.ts`]: `
    export function createIdempotencyKey() {}
  `,
  [`${ROOT}/apps/web/core/components/research/navigation/legacy-route.tsx`]: `
    export const ResearchIaV2Redirect = "legacy-route";
  `,
  [`${ROOT}/apps/web/core/components/research/labels.ts`]: `
    export const RESEARCH_USER_LABELS = "dynamic";
  `,
  [`${ROOT}/apps/web/core/components/research/unused.ts`]: `
    export const ForgottenWidget = "unused";
  `,
  [`${ROOT}/apps/web/core/components/research/default-widget.tsx`]: `
    function DefaultWidget() {}
    export default DefaultWidget;
  `,
  [`${ROOT}/apps/web/core/components/research/consumer.tsx`]: `
    import type { TWidgetState } from "./widget";
    import { CodeList } from "./code";
    import DefaultWidget from "./default-widget";
    export function Page() {
      const state: TWidgetState = "ready";
      return [<CodeList key="code" />, <DefaultWidget key="default" />, state];
    }
  `,
  [`${ROOT}/apps/web/app/routes/core.ts`]: `
    import { ResearchIaV2Redirect } from "@/components/research/navigation/legacy-route";
    export const routes = [ResearchIaV2Redirect];
  `,
  [`${ROOT}/apps/web/tests/side-panel.test.tsx`]: `
    const { ResearchAgentSidePanel } = await import("@/components/research/side-panel");
    ResearchAgentSidePanel();
  `,
  [`${ROOT}/apps/web/tests/compat.test.ts`]: `
    import { createIdempotencyKey } from "@/components/research/compat";
    createIdempotencyKey();
  `,
  [`${ROOT}/packages/i18n/src/locales/zh-CN/common.json`]: JSON.stringify({
    research: {
      user: {
        name: "名称",
      },
    },
  }),
  [`${ROOT}/apps/web/core/components/research/build/generated.ts`]: `
    export const BuildOnlySymbol = "generated";
  `,
  [`${ROOT}/apps/web/core/components/research/dist/generated.ts`]: `
    export const DistOnlySymbol = "generated";
  `,
};

function resultFor(audit, symbol) {
  return audit.results.find((row) => row.symbol === symbol);
}

describe("research reference audit", () => {
  it("classifies runtime, route, default-export, barrel, test-only, retained, i18n and unused symbols", () => {
    const audit = analyzeSourceTexts(sources, { projectRoot: ROOT });

    assert.equal(audit.scanned_files, 14);
    assert.deepEqual(resultFor(audit, "TWidgetState"), {
      symbol: "TWidgetState",
      defined_in: "apps/web/core/components/research/widget.tsx",
      runtime: 1,
      test: 0,
      barrel: 0,
      route: 0,
      i18n_dynamic: "-",
      classification: "runtime",
      suggested_action: "保留运行时引用",
    });
    assert.deepEqual(resultFor(audit, "DefaultWidget"), {
      symbol: "DefaultWidget",
      defined_in: "apps/web/core/components/research/default-widget.tsx",
      runtime: 1,
      test: 0,
      barrel: 0,
      route: 0,
      i18n_dynamic: "-",
      classification: "runtime",
      suggested_action: "保留运行时引用",
    });

    const barrel = resultFor(audit, "CodeList");
    assert.equal(barrel.runtime, 1);
    assert.equal(barrel.barrel, 1);

    const sidePanel = resultFor(audit, "ResearchAgentSidePanel");
    assert.equal(sidePanel.runtime, 0);
    assert.equal(sidePanel.test, 1);
    assert.equal(sidePanel.classification, "test_only");

    const compat = resultFor(audit, "createIdempotencyKey");
    assert.equal(compat.classification, "compat_contract_keep");
    assert.match(compat.suggested_action, /^保留：/);

    const legacyRoute = resultFor(audit, "ResearchIaV2Redirect");
    assert.equal(legacyRoute.runtime, 1);
    assert.equal(legacyRoute.route, 1);
    assert.equal(legacyRoute.classification, "business_required_keep");
    assert.match(legacyRoute.suggested_action, /^保留：/);

    const labels = resultFor(audit, "RESEARCH_USER_LABELS");
    assert.equal(labels.i18n_dynamic, "yes");
    assert.equal(labels.classification, "i18n_dynamic");

    assert.equal(resultFor(audit, "ForgottenWidget").classification, "unused");
    assert.equal(resultFor(audit, "BuildOnlySymbol"), undefined);
    assert.equal(resultFor(audit, "DistOnlySymbol"), undefined);
  });

  it("detects a dynamic i18n key prefix", () => {
    assert.equal(hasDynamicI18nPrefix("RESEARCH_USER_LABELS", ["research.user.name", "common.save"]), true);
    assert.equal(hasDynamicI18nPrefix("RESEARCH_USER_LABELS", ["research.other.name"]), false);
  });

  it("reports baseline regressions and newly unused symbols without mutating input", () => {
    const current = analyzeSourceTexts(sources, { projectRoot: ROOT });
    const baseline = {
      results: [
        {
          symbol: "ForgottenWidget",
          defined_in: "apps/web/core/components/research/unused.ts",
          runtime: 0,
          classification: "unused",
        },
        {
          symbol: "CodeList",
          defined_in: "apps/web/core/components/research/code/code-list.tsx",
          runtime: 0,
          classification: "barrel_only",
        },
        { symbol: "RemovedSymbol", defined_in: "removed.ts", runtime: 1, classification: "runtime" },
      ],
    };
    const snapshot = structuredClone(baseline);
    const comparison = compareAuditToBaseline(current, baseline);

    assert.equal(comparison.ok, false);
    const statuses = comparison.rows.map((row) => row.status);
    assert.equal(statuses[0], "unresolved");
    assert.ok(statuses.includes("reused"));
    assert.ok(statuses.includes("new"));
    assert.ok(statuses.includes("removed"));
    assert.deepEqual(baseline, snapshot);
  });

  it("parses output and baseline arguments", () => {
    assert.deepEqual(parseArguments(["--format", "json", "--compare", "baseline.json"]), {
      format: "json",
      compare: "baseline.json",
      out: undefined,
    });
    assert.equal(parseArguments(["--out", "audit.md"]).out, "audit.md");
    assert.throws(() => parseArguments(["--format", "csv"]), /Unsupported format/);
  });
});
