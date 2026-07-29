import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every path an account leaves a device by must clear every store it left on it.
 *
 * There are two: an ordinary sign-out, and the deleted-account cleanup that
 * runs when someone follows the confirmation link. Phase 17 gave both the Dexie
 * sweep and the last-known-owner forget. Phase 18 added a third store — Cache
 * Storage, holding rendered documents and RSC payloads — and the first version
 * of that slice wired it into the sign-out path only.
 *
 * That asymmetry is invisible to every other test in this suite: each path
 * passes its own tests in full while doing different things. So this asserts
 * the invariant against the source tree, and keys on the DEXIE SWEEP rather
 * than on a list of filenames — a third departure path has to call
 * `clearAccountLocalState` to be one at all, so it is found by what it does
 * rather than by where someone remembered to put it.
 */
const DEXIE_SWEEP = /\bclearAccountLocalState\s*\(/;
const CACHE_SWEEP = /\bclearOwnerSensitiveCachesIfAvailable\s*\(/;

/**
 * Where the sweep is DEFINED and where it is discussed, as opposed to called.
 *
 * `logout.ts` is the implementation; `guest-merge-finalise.ts` explains in a
 * comment why it does not sweep. Neither is a departure path, and both would
 * otherwise be dragged in by a bare text match.
 */
const NOT_DEPARTURE_PATHS = new Set([
  "modules/sync/client/logout.ts",
  "modules/sync/client/guest-merge-finalise.ts",
]);

const ROOTS = ["app", "components", "lib", "modules", "shared"];

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(full);
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      yield full;
    }
  }
}

/** Files that actually CALL the Dexie sweep — comments stripped first. */
function departurePaths(): string[] {
  const found: string[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(join(process.cwd(), root))) {
      const path = relative(process.cwd(), file).replace(/\\/g, "/");
      if (NOT_DEPARTURE_PATHS.has(path)) continue;
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/^\s*\/\/.*$/gm, " ");
      if (DEXIE_SWEEP.test(code)) found.push(path);
    }
  }
  return found.sort();
}

describe("account-departure cleanup", () => {
  it("finds the departure paths by what they do, not by name", () => {
    // Guards the guard. If the pattern ever stopped matching, every assertion
    // below would pass vacuously against an empty list.
    const paths = departurePaths();
    expect(
      paths.length,
      "no departure path found — the scan broke",
    ).toBeGreaterThan(0);
    expect(paths).toEqual([
      "components/account/deleted-account-cleanup.tsx",
      "components/account/sign-out-action.ts",
    ]);
  });

  it("has every one of them clearing Cache Storage too", () => {
    // The finding this exists for: an account's rendered markup surviving on a
    // shared device because only one of the two paths was updated. A third
    // path added later fails HERE, by name, rather than being silently absent.
    for (const path of departurePaths()) {
      const code = readFileSync(join(process.cwd(), path), "utf8");
      expect(
        CACHE_SWEEP.test(code),
        `${path} sweeps Dexie but never clears Cache Storage`,
      ).toBe(true);
    }
  });
});
