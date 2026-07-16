/**
 * Documentation Arabic verification (`pnpm docs:verify`).
 *
 * Verifies every record in docs/.arabic-placeholders.json against the
 * immutable original and enriched datasets: the placeholder resolves, the
 * original and enriched values agree (for source fields), the value is NFC,
 * the sidecar's value/escape/codepoint-count are exact, and the target
 * documentation file still contains the exact resolved value.
 *
 * Read-only by default. `--write` fills any UNRESOLVED {{...}} placeholders
 * in the recorded files directly from JSON (targeted replacement only,
 * never manual Arabic, never run in CI).
 *
 * NODE-ONLY tool; pure helpers are exported for unit tests.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { isNfc, toEscaped } from "@/shared/arabic/extract";

export type PlaceholderTarget =
  | { kind: "entry"; entryId: number; field: string }
  | { kind: "bab"; babId: string };

export type SidecarRecord = {
  file: string;
  placeholder: string;
  value: string;
  escaped: string;
  codepoints: number;
};

const ENTRY_PATTERN = /^\{\{entry:(\d+):([a-z_]+)\}\}$/;
const BAB_PATTERN = /^\{\{bab:([a-z]+):bab_arabic\}\}$/;

/** Parse a `{{entry:ID:field}}` / `{{bab:ID:bab_arabic}}` placeholder. */
export function parsePlaceholder(placeholder: string): PlaceholderTarget {
  const entryMatch = ENTRY_PATTERN.exec(placeholder);
  if (entryMatch) {
    return {
      kind: "entry",
      entryId: Number(entryMatch[1]),
      field: entryMatch[2],
    };
  }
  const babMatch = BAB_PATTERN.exec(placeholder);
  if (babMatch) {
    return { kind: "bab", babId: babMatch[1] };
  }
  throw new Error(`unsupported placeholder: ${placeholder}`);
}

type Datasets = {
  originalById: Map<number, Record<string, unknown>>;
  enrichedById: Map<number, Record<string, unknown>>;
};

/**
 * Resolve a placeholder to its exact value, enforcing original==enriched
 * for source fields and bab_arabic consistency across the whole bab.
 */
export function resolvePlaceholder(
  target: PlaceholderTarget,
  datasets: Datasets,
): string {
  if (target.kind === "entry") {
    const original = datasets.originalById.get(target.entryId);
    const enriched = datasets.enrichedById.get(target.entryId);
    if (!original || !enriched) {
      throw new Error(`entry ${target.entryId} not found in both datasets`);
    }
    const originalValue = original[target.field];
    const enrichedValue = enriched[target.field];
    if (
      typeof originalValue !== "string" ||
      typeof enrichedValue !== "string"
    ) {
      throw new Error(
        `entry ${target.entryId} field ${target.field} missing or non-string`,
      );
    }
    if (originalValue !== enrichedValue) {
      throw new Error(
        `entry ${target.entryId} field ${target.field}: original and enriched differ ` +
          `(${toEscaped(originalValue)} vs ${toEscaped(enrichedValue)})`,
      );
    }
    return originalValue;
  }

  const values = new Set<string>();
  for (const map of [datasets.originalById, datasets.enrichedById]) {
    for (const entry of map.values()) {
      if (entry.bab === target.babId) {
        values.add(entry.bab_arabic as string);
      }
    }
  }
  if (values.size === 0) throw new Error(`bab ${target.babId} has no entries`);
  if (values.size > 1) {
    throw new Error(`bab ${target.babId} has inconsistent bab_arabic values`);
  }
  return [...values][0];
}

/** Verify one sidecar record. Returns a list of problems (empty = OK). */
export function verifyRecord(
  record: SidecarRecord,
  datasets: Datasets,
  readDocFile: (relPath: string) => string | null,
): string[] {
  const problems: string[] = [];
  let resolved: string;
  try {
    resolved = resolvePlaceholder(
      parsePlaceholder(record.placeholder),
      datasets,
    );
  } catch (error) {
    return [`${record.placeholder}: ${(error as Error).message}`];
  }

  if (!isNfc(resolved)) {
    problems.push(`${record.placeholder}: resolved value is not NFC`);
  }
  if (record.value !== resolved) {
    problems.push(
      `${record.placeholder}: sidecar value drifted (expected ${toEscaped(resolved)}, recorded ${toEscaped(record.value)})`,
    );
  }
  if (record.escaped !== toEscaped(resolved)) {
    problems.push(`${record.placeholder}: sidecar escape drifted`);
  }
  if (record.codepoints !== [...resolved].length) {
    problems.push(`${record.placeholder}: sidecar codepoint count drifted`);
  }
  const docText = readDocFile(record.file);
  if (docText === null) {
    problems.push(`${record.placeholder}: target file ${record.file} missing`);
  } else if (!docText.includes(resolved)) {
    problems.push(
      `${record.placeholder}: ${record.file} no longer contains the exact value ${toEscaped(resolved)} (manually altered or reordered?)`,
    );
  }
  return problems;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const REPO_ROOT = join(import.meta.dirname, "..");
const SIDECAR_PATH = join(REPO_ROOT, "docs", ".arabic-placeholders.json");
const PLACEHOLDER_SCAN = /\{\{(?:entry:\d+:[a-z_]+|bab:[a-z]+:bab_arabic)\}\}/g;

function loadDatasets(): Datasets {
  const original = JSON.parse(
    readFileSync(
      join(REPO_ROOT, "data", "safwa-mujarrad.original.json"),
      "utf8",
    ),
  ) as { entries: Array<Record<string, unknown> & { id: number }> };
  const enriched = JSON.parse(
    readFileSync(join(REPO_ROOT, "data", "safwa-vocabulary.v2.json"), "utf8"),
  ) as { mujarrad_entries: Array<Record<string, unknown> & { id: number }> };
  return {
    originalById: new Map(original.entries.map((entry) => [entry.id, entry])),
    enrichedById: new Map(
      enriched.mujarrad_entries.map((entry) => [entry.id, entry]),
    ),
  };
}

function main(): number {
  const write = process.argv.includes("--write");
  const datasets = loadDatasets();
  const sidecar = JSON.parse(readFileSync(SIDECAR_PATH, "utf8")) as {
    entries: SidecarRecord[];
  };

  if (write) {
    const files = new Set(sidecar.entries.map((record) => record.file));
    for (const file of files) {
      const path = join(REPO_ROOT, file);
      const text = readFileSync(path, "utf8");
      const filled = text.replace(PLACEHOLDER_SCAN, (placeholder) =>
        resolvePlaceholder(parsePlaceholder(placeholder), datasets),
      );
      if (filled !== text) {
        writeFileSync(path, filled, "utf8");
        console.log(`filled placeholders in ${file}`);
      }
    }
  }

  const problems: string[] = [];
  for (const record of sidecar.entries) {
    problems.push(
      ...verifyRecord(record, datasets, (relPath) => {
        try {
          return readFileSync(join(REPO_ROOT, relPath), "utf8");
        } catch {
          return null;
        }
      }),
    );
  }

  if (problems.length > 0) {
    console.error("docs:verify FAILED:");
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(
    `docs:verify OK — ${sidecar.entries.length} placeholder record(s) verified against both datasets`,
  );
  return 0;
}

const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  process.exit(main());
}
