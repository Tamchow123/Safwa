/**
 * Search-based guard (Phase 12 §23): no study path may reintroduce an
 * unconditional browser clock. Every study runner must obtain its clock
 * through the shared effective-clock resolver (modules/profile/timezone),
 * which is the ONLY place allowed to read the ambient timezone or emit
 * `browser_detected`.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const STUDY_DIR = path.join(REPO_ROOT, "components", "study");

function studySources(): { file: string; source: string }[] {
  return fs
    .readdirSync(STUDY_DIR, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
    .map((entry) => {
      const file = path.join(entry.parentPath ?? STUDY_DIR, entry.name);
      return { file, source: fs.readFileSync(file, "utf8") };
    });
}

describe("study paths use the shared effective clock (§10.5/§23 guard)", () => {
  it("finds the study components to guard", () => {
    const names = studySources().map(({ file }) => path.basename(file));
    for (const required of [
      "quiz-runner.tsx",
      "flashcard-session.tsx",
      "mixed-session.tsx",
      "custom-session.tsx",
      "study-shared.tsx",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("no study component references browserClock", () => {
    for (const { file, source } of studySources()) {
      expect
        .soft(source.includes("browserClock"), `${file} uses browserClock`)
        .toBe(false);
    }
  });

  it("no study component reads the ambient timezone directly", () => {
    for (const { file, source } of studySources()) {
      expect
        .soft(
          source.includes("resolvedOptions()"),
          `${file} reads Intl.DateTimeFormat().resolvedOptions()`,
        )
        .toBe(false);
    }
  });

  it("no study component hardcodes a timezone source", () => {
    for (const { file, source } of studySources()) {
      expect
        .soft(
          source.includes('"browser_detected"') ||
            source.includes('"user_setting"'),
          `${file} hardcodes a timezoneSource literal`,
        )
        .toBe(false);
    }
  });

  it("both graded-attempt runners resolve the session-frozen clock", () => {
    for (const runner of ["quiz-runner.tsx", "flashcard-session.tsx"]) {
      const source = fs.readFileSync(path.join(STUDY_DIR, runner), "utf8");
      expect(source, `${runner} must read the effective clock`).toContain(
        "readEffectiveClock",
      );
      expect(source, `${runner} must freeze the clock per session`).toContain(
        "sessionClock",
      );
    }
  });
});
