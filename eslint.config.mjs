import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

/**
 * Purity guard for the pure-TypeScript engine/scheduler/analytics modules
 * (docs/ARCHITECTURE.md §2). These run identically in the browser and on the
 * server, so hidden nondeterminism (Date.now / Math.random / crypto) and
 * React/DOM/DB imports are forbidden — clocks and randomness are injected.
 * The analytics PERSISTENCE adapters (modules/analytics/persistence.ts,
 * modules/analytics/weakness-persistence.ts) are the module's sanctioned
 * browser-only Dexie boundaries and are exempted via the scoped `ignores` on
 * the guard block below — every other analytics file stays fully guarded.
 * Extend that per-file list, never these rules.
 */
const PURE_MODULE_FILES = [
  "modules/study-engine/**/*.ts",
  "modules/scheduler/**/*.ts",
  "modules/analytics/**/*.ts",
];

const nondeterminismRules = {
  "no-restricted-syntax": [
    "error",
    {
      selector: "MemberExpression[object.name='Date'][property.name='now']",
      message:
        "Date.now() is nondeterministic; inject a clock (see modules/study-engine/attempts.ts).",
    },
    {
      selector: "MemberExpression[object.name='Math'][property.name='random']",
      message:
        "Math.random() is nondeterministic; use the seeded RNG in modules/study-engine/rng.ts.",
    },
    {
      selector: "NewExpression[callee.name='Date'][arguments.length=0]",
      message:
        "new Date() reads the ambient clock; pass an explicit epoch value.",
    },
    {
      selector: "Identifier[name='crypto']",
      message:
        "crypto is nondeterministic in a pure module; derive ids from seeds (modules/study-engine/rng.ts).",
    },
  ],
  "no-restricted-imports": [
    "error",
    {
      paths: [
        { name: "react", message: "The pure engine must not import React." },
        {
          name: "react-dom",
          message: "The pure engine must not import react-dom.",
        },
        { name: "dexie", message: "The pure engine must not import Dexie." },
        {
          name: "crypto",
          message:
            "The pure engine must not import Node crypto (nondeterministic); derive ids from seeds or inject them.",
        },
        {
          name: "node:crypto",
          message:
            "The pure engine must not import Node crypto (nondeterministic); derive ids from seeds or inject them.",
        },
      ],
      patterns: [
        {
          group: ["@/modules/content/db", "**/content/db"],
          message: "The pure engine must not import the Dexie database module.",
        },
      ],
    },
  ],
};

/**
 * Phase 17 §14 (SEC-001) — the merge-union escape hatch is not general-purpose.
 *
 * `classifyMergeLineage` relaxes the lineage rule that stops one device
 * silently overwriting another's history, and `mergeUnionContext` mints the
 * branded evidence that relaxation is allowed. Together they are the only way
 * to persist a second root on a component, so an import of either from a file
 * that has not thought about that is the beginning of a hole in the trust
 * boundary — reachable, eventually, from an ordinary push.
 *
 * They are therefore importable from ONE file. `ingest.ts` is the server's only
 * write path into `review_events`, and it consults them only for an event
 * bearing merge provenance the coordinator wrote. `lineage.ts` itself and its
 * own test are exempt because that is where they are defined and proved.
 *
 * The exemption list is the whole point — extend it only with a file that has a
 * reason to be there, never by widening the pattern.
 */
const MERGE_LINEAGE_CALLERS = [
  "modules/sync/server/ingest.ts",
  "modules/sync/server/lineage.ts",
  "modules/sync/server/lineage.test.ts",
];

const mergeLineageBoundary = {
  "no-restricted-imports": [
    "error",
    {
      patterns: [
        {
          group: ["**/sync/server/lineage", "**/server/lineage", "./lineage"],
          importNames: ["classifyMergeLineage", "mergeUnionContext"],
          message:
            "The merge-union lineage rule is reachable only from modules/sync/server/ingest.ts, which applies it to events the guest-merge coordinator marked as imported. Ordinary sync must keep Phase 16's rule (phases-17.md §14).",
        },
      ],
    },
  ],
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    files: PURE_MODULE_FILES,
    // The analytics PERSISTENCE adapters are the module's sanctioned
    // browser-only Dexie boundaries (like study-session/persistence.ts, which
    // lives outside the guard entirely); every other analytics file stays
    // fully guarded. weakness-persistence.ts (Phase 13) is the weakness
    // analytics' own thin Dexie adapter, mirroring persistence.ts exactly.
    ignores: [
      "modules/analytics/persistence.ts",
      "modules/analytics/weakness-persistence.ts",
    ],
    rules: nondeterminismRules,
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: MERGE_LINEAGE_CALLERS,
    rules: mergeLineageBoundary,
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "pnpm-lock.yaml",
  ]),
]);

export default eslintConfig;
