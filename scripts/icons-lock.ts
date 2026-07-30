/**
 * The icon lock — what `public/icons/` is supposed to contain, recorded when
 * the icons were generated and verifiable afterwards WITHOUT sharp.
 *
 * Why a lock file rather than simply re-rendering and comparing bytes:
 *
 * Re-rendering is the stronger check, but it is only meaningful on the machine
 * that produced the committed bytes. sharp ships a separately compiled native
 * binary per OS and architecture (the lockfile carries `@img/sharp-linux-x64`,
 * `@img/sharp-darwin-arm64` and friends; win32 statically links libvips
 * instead of resolving a `@img/sharp-libvips-*` package at all), and libvips'
 * resize and composite kernels are not contractually bit-identical across
 * those builds. Byte equality across platforms is therefore something to hope
 * for, not something to gate CI on: if it ever failed, it would fail on every
 * pull request, for a reason unrelated to the change under review, and the
 * only way out would be to loosen the check under pressure.
 *
 * So the guarantee is split in two:
 *
 *  - THIS module is the portable half. It re-reads nothing through sharp; it
 *    compares recorded SHA-256 digests, the declared icon set and the master's
 *    brand colours. It runs identically on every platform, in-process, in
 *    milliseconds — which is what makes it safe to put in the unit suite and
 *    therefore in CI. It catches every drift that actually happens in
 *    practice: a master edited without regenerating, an icon added to
 *    `SITE_ICONS` but never rendered, a stray or deleted file under
 *    `public/icons/`, an encoder setting changed without a rebuild.
 *
 *  - `scripts/generate-icons.ts --check` (`pnpm icons:verify`) is the exact
 *    half. It genuinely re-renders and compares bytes, and is run by
 *    `scripts/quality-gate.ps1` on the machine icons are authored on, where
 *    byte equality is a real expectation rather than a cross-platform hope.
 *
 * The same premise binds the BUILD path, not just the verify path: rendering
 * on a machine that did not author the icons would rewrite them for a reason
 * indistinguishable, in a diff, from an intended edit. `generatedOn` and
 * `isForeignPlatform` below are what let `pnpm icons:build` refuse that rather
 * than doing it quietly.
 *
 * Nothing here imports sharp, and nothing here may start to.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { siteConfig, SITE_ICONS, type IconSpec } from "../lib/site";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MASTER_SVG = join(REPO_ROOT, "assets", "brand", "safwa-mark.svg");
export const ICONS_DIR = join(REPO_ROOT, "public", "icons");
export const LOCK_FILE = join(REPO_ROOT, "assets", "brand", "icons.lock.json");

/**
 * Every input that changes the rendered bytes, in one object.
 *
 * It is recorded in the lock so that changing any of it without regenerating
 * is a test failure rather than a silent divergence between the committed
 * PNGs and the code that claims to produce them. Comments and refactoring in
 * the generator deliberately do NOT appear here — only the values that reach
 * sharp.
 */
export const RENDER_SETTINGS = {
  /** Corner radius of a `rounded` icon, as a fraction of its edge. */
  cornerRadiusRatio: 0.22,
  /** The master's viewBox edge, and the density that renders it 1:1. */
  masterEdge: 512,
  baseDensity: 72,
  /** Pinned PNG encoder options — sharp's defaults may move between versions. */
  png: {
    compressionLevel: 9,
    effort: 10,
    palette: false,
    force: true,
  },
} as const;

export type RenderSettings = typeof RENDER_SETTINGS;

export type LockedIcon = {
  file: string;
  size: number;
  shape: IconSpec["shape"];
  sha256: string;
};

export type GeneratedOn = { platform: string; arch: string; sharp: string };

export type IconsLock = {
  /**
   * Where the committed bytes came from. Never asserted — a lock generated on
   * one platform has to stay valid on every other, so `checkIconsLock` ignores
   * this field entirely. It is used by `scripts/generate-icons.ts` for two
   * things a digest cannot do on its own: explaining a byte mismatch that is
   * only a platform difference, and refusing to silently re-bake the committed
   * icons from a platform that did not author them.
   */
  generatedOn: GeneratedOn;
  master: string;
  settings: RenderSettings;
  icons: LockedIcon[];
};

/** True when `lock` records a different platform/arch than this process. */
export function isForeignPlatform(lock: IconsLock): boolean {
  return (
    lock.generatedOn.platform !== process.platform ||
    lock.generatedOn.arch !== process.arch
  );
}

export function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Stable serialisation, so key order in the lock file is never load-bearing. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The distinct `fill="#rrggbb"` literals in the master, lowercased and sorted.
 *
 * The master is hand-authored SVG, so its colours are hand-typed hex — the one
 * place in the icon pipeline where a value can disagree with `siteConfig`
 * without anything noticing. `scripts/generate-icons.ts` flattens square
 * exports over `siteConfig.themeColor`, so a disagreement would ship a visible
 * colour seam between an icon's field and its own edge.
 */
export function masterFillColours(svg: string): string[] {
  const literals = svg.match(/fill="(#[0-9a-fA-F]+)"/g) ?? [];
  const values = literals.map((literal) =>
    literal.slice('fill="'.length, -1).toLowerCase(),
  );
  return [...new Set(values)].sort();
}

/** The colours the master is allowed to use, from the one authoritative copy. */
export function brandFillColours(): string[] {
  return [
    ...new Set([
      siteConfig.themeColor.toLowerCase(),
      siteConfig.backgroundColor.toLowerCase(),
    ]),
  ].sort();
}

/**
 * Throw unless the master's palette is exactly the two brand colours.
 * Called before rendering, so `pnpm icons:build` refuses to produce icons from
 * a master that has drifted rather than baking the drift into the lock.
 */
export function assertMasterBrandColours(svg: string): void {
  const found = masterFillColours(svg);
  const expected = brandFillColours();
  if (canonical(found) !== canonical(expected)) {
    throw new Error(
      `assets/brand/safwa-mark.svg uses ${JSON.stringify(found)} but ` +
        `lib/site.ts's siteConfig declares ${JSON.stringify(expected)}. ` +
        "Both are hand-maintained copies of app/globals.css's --primary and " +
        "--background tokens; make them agree before regenerating.",
    );
  }
}

export function readIconsLock(): IconsLock {
  return JSON.parse(readFileSync(LOCK_FILE, "utf8")) as IconsLock;
}

/**
 * `generatedOn` is passed in rather than derived here, because it must follow
 * the BYTES: a run that renders nothing new leaves the committed PNGs exactly
 * as the original platform produced them, so claiming this machine made them
 * would be a lie the next `icons:verify` acts on.
 */
export function buildIconsLock(
  entries: readonly LockedIcon[],
  generatedOn: GeneratedOn,
): IconsLock {
  return {
    generatedOn: { ...generatedOn },
    master: sha256(readFileSync(MASTER_SVG)),
    settings: RENDER_SETTINGS,
    icons: [...entries],
  };
}

/**
 * Verify the committed icon set against the lock. Returns one message per
 * problem; an empty array means everything agrees.
 */
export function checkIconsLock(): string[] {
  const problems: string[] = [];

  let masterSvg: string;
  try {
    masterSvg = readFileSync(MASTER_SVG, "utf8");
  } catch {
    return [`${LOCK_FILE}: master SVG ${MASTER_SVG} is missing`];
  }

  try {
    assertMasterBrandColours(masterSvg);
  } catch (error) {
    problems.push((error as Error).message);
  }

  let lock: IconsLock;
  try {
    lock = readIconsLock();
  } catch (error) {
    problems.push(
      `assets/brand/icons.lock.json is missing or unreadable (${(error as Error).message}). ` +
        "Run `pnpm icons:build`.",
    );
    return problems;
  }

  if (canonical(lock.settings) !== canonical(RENDER_SETTINGS)) {
    problems.push(
      "render settings changed since the icons were generated " +
        `(lock ${canonical(lock.settings)} vs current ${canonical(RENDER_SETTINGS)}). ` +
        "Run `pnpm icons:build` and commit the result.",
    );
  }

  const masterHash = sha256(readFileSync(MASTER_SVG));
  if (lock.master !== masterHash) {
    problems.push(
      "assets/brand/safwa-mark.svg was edited without regenerating the icons " +
        `(lock ${lock.master.slice(0, 12)}…, file ${masterHash.slice(0, 12)}…). ` +
        "Run `pnpm icons:build` and commit the result.",
    );
  }

  const declared = SITE_ICONS.map((spec) => ({
    file: spec.file,
    size: spec.size,
    shape: spec.shape,
  }));
  const locked = lock.icons.map((entry) => ({
    file: entry.file,
    size: entry.size,
    shape: entry.shape,
  }));
  if (canonical(locked) !== canonical(declared)) {
    problems.push(
      "lib/site.ts's SITE_ICONS no longer matches the generated set " +
        `(lock ${canonical(locked)} vs declared ${canonical(declared)}). ` +
        "Run `pnpm icons:build` and commit the result.",
    );
    // The per-file digests below are keyed off the lock, so a set mismatch
    // makes the rest of this check meaningless rather than merely noisy.
    return problems;
  }

  for (const entry of lock.icons) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(ICONS_DIR, entry.file));
    } catch {
      problems.push(`public/icons/${entry.file} is missing`);
      continue;
    }
    const digest = sha256(bytes);
    if (digest !== entry.sha256) {
      problems.push(
        `public/icons/${entry.file} is not the file that was generated ` +
          `(lock ${entry.sha256.slice(0, 12)}…, file ${digest.slice(0, 12)}…)`,
      );
    }
  }

  // A file nobody generated is as much a defect as a missing one: it ships in
  // `public/`, and neither the manifest nor `icons:verify` would ever mention
  // it, because both iterate SITE_ICONS rather than the directory.
  let present: string[];
  try {
    present = readdirSync(ICONS_DIR).sort();
  } catch {
    problems.push(`public/icons/ is missing. Run \`pnpm icons:build\`.`);
    return problems;
  }
  const expectedFiles = lock.icons.map((entry) => entry.file).sort();
  const stray = present.filter((file) => !expectedFiles.includes(file));
  if (stray.length > 0) {
    problems.push(
      `public/icons/ contains ${stray.length} file(s) nothing generates: ` +
        stray.join(", "),
    );
  }

  return problems;
}
