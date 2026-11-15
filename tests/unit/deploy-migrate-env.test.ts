import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EMAIL_TRANSPORTS, SMTP_REQUIRED_ENV } from "@/modules/env/rules";
import { REQUIRED_PRODUCTION_ENV } from "@/scripts/verify-deploy-preconditions";

/**
 * The migration workflow hands production's environment to its steps by hand
 * (Phase 18.2).
 *
 * `deploy-migrate.yml` runs `pnpm deploy:verify`, `pnpm db:migrate` and
 * `pnpm db:register-content` with NODE_ENV=production, so each of those steps
 * must carry a configuration the production validators accept. Nothing else
 * checks that: the workflow is manual-dispatch only, so a stale environment
 * block surfaces on the day someone needs to migrate production — which is
 * exactly what Phase 18.2's removal of Resend would have caused had the
 * workflow not been updated alongside it.
 *
 * Read as text rather than parsed, the same way the action-pinning test reads
 * these files, so this adds no YAML dependency.
 */
const WORKFLOW = join(process.cwd(), ".github/workflows/deploy-migrate.yml");

type StepEnv = Map<string, string>;

/** Each step's `env:` mapping, keyed by the step's `name:`. */
function stepEnvironments(source: string): Map<string, StepEnv> {
  const steps = new Map<string, StepEnv>();
  let stepName: string | undefined;
  let envIndent: number | undefined;

  for (const line of source.split(/\r?\n/)) {
    const indent = line.length - line.trimStart().length;
    const text = line.trim();
    if (text === "" || text.startsWith("#")) continue;

    const step = /^- name:\s*(.+)$/.exec(text);
    if (step) {
      stepName = step[1];
      envIndent = undefined;
      continue;
    }
    if (envIndent !== undefined && indent <= envIndent) envIndent = undefined;
    if (stepName && text === "env:") {
      envIndent = indent;
      steps.set(stepName, new Map());
      continue;
    }
    const entry = /^([A-Z_][A-Z0-9_]*):\s*(.*)$/.exec(text);
    if (stepName && envIndent !== undefined && entry) {
      steps.get(stepName)?.set(entry[1], entry[2]);
    }
  }
  return steps;
}

const source = readFileSync(WORKFLOW, "utf8");
const emailSteps = [...stepEnvironments(source)].filter(([, env]) =>
  env.has("EMAIL_TRANSPORT"),
);

describe("deploy-migrate.yml's production environment", () => {
  it("is handed to the three steps that validate it", () => {
    expect(emailSteps.map(([name]) => name)).toEqual([
      "Verify deploy preconditions",
      "Apply full migration chain",
      "Register content versions",
    ]);
  });

  it.each(emailSteps)(
    "%s selects a transport that exists and is not the console one",
    (_name, env) => {
      const transport = env.get("EMAIL_TRANSPORT");
      expect(EMAIL_TRANSPORTS).toContain(transport);
      expect(transport).not.toBe("console-file");
    },
  );

  it.each(emailSteps)(
    "%s carries every variable production requires",
    (_name, env) => {
      for (const variable of [
        ...REQUIRED_PRODUCTION_ENV,
        ...SMTP_REQUIRED_ENV,
      ]) {
        expect(env.has(variable), variable).toBe(true);
      }
    },
  );

  it.each(emailSteps)(
    "%s reads the SMTP password from a secret, never a variable",
    (_name, env) => {
      // Repository variables are readable by anyone with read access.
      expect(env.get("SMTP_PASSWORD")).toMatch(/^\$\{\{\s*secrets\./);
    },
  );

  it("no longer mentions the removed Resend provider", () => {
    expect(source).not.toMatch(/RESEND/);
  });
});
