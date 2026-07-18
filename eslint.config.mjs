import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

/**
 * Purity guard for the pure-TypeScript engine/scheduler modules
 * (docs/ARCHITECTURE.md §2). These run identically in the browser and on the
 * server, so hidden nondeterminism (Date.now / Math.random / crypto) and
 * React/DOM/DB imports are forbidden — clocks and randomness are injected.
 */
const PURE_MODULE_FILES = [
  "modules/study-engine/**/*.ts",
  "modules/scheduler/**/*.ts",
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

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    files: PURE_MODULE_FILES,
    rules: nondeterminismRules,
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
