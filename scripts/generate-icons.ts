/**
 * Rasterise the app mark into the PWA icon set (`pnpm icons:build`).
 *
 * `assets/brand/safwa-mark.svg` is the single master; every file under
 * `public/icons/` is derived from it and NONE of them may be hand-edited. The
 * outputs are committed rather than generated at build time, because
 * `app/manifest.ts` promises those exact URLs and a missing icon is an
 * installability failure that no build step would surface — the manifest still
 * serves, the install prompt just never appears.
 *
 * WHICH icons are shipped is declared in `lib/site.ts`'s `SITE_ICONS`, not
 * here: `app/manifest.ts` and the unit tests need that list, and neither may
 * import a module that pulls `sharp` into a Next build or a jsdom test run.
 * Everything that changes the rendered BYTES lives in `scripts/icons-lock.ts`'s
 * `RENDER_SETTINGS`, for the same reason — the check that the committed icons
 * are current has to be able to read those values without sharp.
 *
 * Two shapes, for two different platform behaviours:
 *  - `maskable` gets the raw square. Android crops it to whatever shape the
 *    launcher uses, so the art must survive a circle of 80% diameter — the
 *    master's own geometry note explains how it does.
 *  - `any` gets rounded corners, because a bare square is displayed unaltered
 *    and looks unfinished beside icons that were designed for the slot.
 *
 * FRESHNESS is what makes committing generated files safe, and it is checked
 * in two places for two different reasons. `--check` here (`pnpm icons:verify`)
 * re-renders and compares bytes exactly; `scripts/quality-gate.ps1` runs it,
 * on the machine the icons are authored on. `scripts/icons-lock.ts` does the
 * portable half — digests, declared set, brand colours — and is what the unit
 * suite and therefore CI rely on, because sharp's per-platform native builds
 * make cross-platform byte equality a hope rather than a guarantee. That file's
 * header explains the split in full.
 *
 * That same asymmetry is why plain `pnpm icons:build` REFUSES to run when the
 * lock records a different platform and any bytes would change: re-rendering
 * elsewhere looks exactly like an intended edit in a diff, and a later build
 * back on the authoring machine would silently undo it. `--allow-foreign-
 * platform` is the deliberate way to move authorship instead.
 *
 * NODE-ONLY: imports sharp. Nothing here is exported; the test-facing helpers
 * are all in `scripts/icons-lock.ts`, which is sharp-free by design.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import sharp from "sharp";

import { siteConfig, SITE_ICONS, type IconSpec } from "../lib/site";
import {
  assertMasterBrandColours,
  buildIconsLock,
  checkIconsLock,
  ICONS_DIR,
  isForeignPlatform,
  LOCK_FILE,
  MASTER_SVG,
  readIconsLock,
  RENDER_SETTINGS,
  sha256,
  type GeneratedOn,
  type IconsLock,
  type LockedIcon,
} from "./icons-lock";

/** The flag that lets a foreign platform take authorship of the icon set. */
const ALLOW_FOREIGN_FLAG = "--allow-foreign-platform";

/** The rounded-corner mask, as an SVG string sized to `size`. */
function roundedMaskSvg(size: number): string {
  const radius = Math.round(size * RENDER_SETTINGS.cornerRadiusRatio);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`;
}

async function renderIcon(master: Buffer, spec: IconSpec): Promise<Buffer> {
  // `density` scales the SVG rasteriser rather than resampling a fixed
  // bitmap, so small sizes stay crisp instead of being downsampled mush.
  const base = sharp(master, {
    density: (RENDER_SETTINGS.baseDensity * spec.size) / RENDER_SETTINGS.masterEdge,
  }).resize(spec.size, spec.size, { fit: "contain" });
  const shaped =
    spec.shape === "rounded"
      ? // The corners this cuts away are the ONLY reason an `any` icon needs
        // an alpha channel; everything else in the master is full-bleed.
        base.composite([
          {
            input: Buffer.from(roundedMaskSvg(spec.size)),
            blend: "dest-in",
          },
        ])
      : // Square exports are flattened rather than left RGBA. iOS composites a
        // home-screen icon over BLACK instead of honouring transparency, so an
        // unnecessary alpha channel is a standing invitation to a black edge on
        // someone's phone the first time the art stops reaching a border.
        //
        // The flatten colour comes from siteConfig, while the field it has to
        // match is a hex literal inside the master — which is exactly why
        // assertMasterBrandColours() runs before any of this.
        base.flatten({ background: siteConfig.themeColor });
  return shaped.png(RENDER_SETTINGS.png).toBuffer();
}

type RenderedIcon = {
  spec: IconSpec;
  bytes: Buffer;
  sha256: string;
  /** True when the on-disk bytes already matched what was rendered. */
  unchanged: boolean;
};

/**
 * Render every icon into memory. This function NEVER writes: build mode has to
 * see the whole result set before it can decide whether writing is allowed at
 * all (see the foreign-platform guard in `main`), and a half-written icon
 * directory is a worse state than an unchanged one.
 */
async function renderAll(): Promise<RenderedIcon[]> {
  const master = readFileSync(MASTER_SVG);
  assertMasterBrandColours(master.toString("utf8"));

  const rendered: RenderedIcon[] = [];
  for (const spec of SITE_ICONS) {
    const bytes = await renderIcon(master, spec);
    const digest = sha256(bytes);
    let existing: Buffer | null = null;
    try {
      existing = readFileSync(join(ICONS_DIR, spec.file));
    } catch {
      existing = null;
    }
    rendered.push({
      spec,
      bytes,
      sha256: digest,
      unchanged: existing !== null && sha256(existing) === digest,
    });
  }
  return rendered;
}

function currentGeneratedOn(): GeneratedOn {
  const versions = sharp.versions as Record<string, string | undefined>;
  return {
    platform: process.platform,
    arch: process.arch,
    sharp: `sharp ${versions.sharp ?? "unknown"}, libvips ${versions.vips ?? "unknown"}`,
  };
}

/** Write the lock unless it already says exactly this. Returns true if written. */
function writeIconsLock(
  rendered: readonly RenderedIcon[],
  generatedOn: GeneratedOn,
): boolean {
  const entries: LockedIcon[] = rendered.map((icon) => ({
    file: icon.spec.file,
    size: icon.spec.size,
    shape: icon.spec.shape,
    sha256: icon.sha256,
  }));
  const serialised = `${JSON.stringify(buildIconsLock(entries, generatedOn), null, 2)}\n`;
  let existing: string | null = null;
  try {
    existing = readFileSync(LOCK_FILE, "utf8");
  } catch {
    existing = null;
  }
  if (existing === serialised) return false;
  writeFileSync(LOCK_FILE, serialised);
  return true;
}

function tryReadIconsLock(): IconsLock | null {
  try {
    return readIconsLock();
  } catch {
    return null;
  }
}

function reportLockProblems(problems: readonly string[]): void {
  console.error(
    `The committed icon set does not match assets/brand/icons.lock.json ` +
      `(${problems.length} problem(s)):\n- ${problems.join("\n- ")}`,
  );
}

function describeForeign(lock: IconsLock): string {
  return (
    `The committed icons were generated on ${lock.generatedOn.platform}/${lock.generatedOn.arch} ` +
    `with ${lock.generatedOn.sharp}; this is ${process.platform}/${process.arch}.`
  );
}

async function runCheck(): Promise<void> {
  // The portable half first: it is the same check CI runs via `pnpm test`, so
  // a failure here means the same failure there, and its messages name the
  // cause directly rather than leaving it to a byte comparison.
  const problems = checkIconsLock();
  if (problems.length > 0) {
    reportLockProblems(problems);
    process.exitCode = 1;
    return;
  }

  const rendered = await renderAll();
  const drifted = rendered.filter((icon) => !icon.unchanged);
  if (drifted.length === 0) {
    console.log(`All ${rendered.length} icons match assets/brand/safwa-mark.svg.`);
    return;
  }

  const lock = readIconsLock();
  console.error(
    `Re-rendering produced different bytes for ${drifted.length} of ` +
      `${rendered.length} icons:\n- ` +
      drifted.map((icon) => icon.spec.file).join("\n- "),
  );
  console.error(
    isForeignPlatform(lock)
      ? `${describeForeign(lock)} sharp's native builds differ per platform, so byte ` +
          "equality across them is not guaranteed — and the portable check above already " +
          "passed, which means the committed icons ARE the ones that were generated. " +
          "Re-verify on the authoring platform before treating this as a defect."
      : "The lock agrees with the committed files, so this is an encoder change rather " +
          "than a stale commit. Run `pnpm icons:build` and commit the result.",
  );
  process.exitCode = 1;
}

async function runBuild(allowForeign: boolean): Promise<void> {
  const existing = tryReadIconsLock();
  const rendered = await renderAll();
  const drifted = rendered.filter((icon) => !icon.unchanged);

  // Refuse BEFORE writing anything. Re-rendering on a machine that did not
  // author the set produces a diff indistinguishable from an intended edit —
  // and the next build back on the original machine would silently undo it,
  // leaving binary churn nobody can attribute. Nothing has been written yet,
  // so exiting here leaves the working tree exactly as it was found.
  if (existing !== null && isForeignPlatform(existing) && drifted.length > 0) {
    if (!allowForeign) {
      console.error(
        `Refusing to rewrite ${drifted.length} of ${rendered.length} icons:\n- ` +
          drifted.map((icon) => icon.spec.file).join("\n- "),
      );
      console.error(
        `${describeForeign(existing)} Different bytes here are at least as likely to be ` +
          "the platform as a real change, so this would commit churn nobody can attribute. " +
          "Nothing was written. Regenerate on the authoring platform, or pass " +
          `\`${ALLOW_FOREIGN_FLAG}\` to move authorship of the icon set to this one.`,
      );
      process.exitCode = 1;
      return;
    }
    console.warn(
      `${describeForeign(existing)} ${ALLOW_FOREIGN_FLAG} was passed, so this machine is ` +
        "taking authorship of the icon set. Review the rendered PNGs before committing.",
    );
  }

  mkdirSync(ICONS_DIR, { recursive: true });
  for (const icon of drifted) {
    writeFileSync(join(ICONS_DIR, icon.spec.file), icon.bytes);
  }

  // `generatedOn` follows the bytes. A run that rendered nothing new leaves the
  // committed PNGs exactly as the original platform produced them, so recording
  // this machine instead would be a claim the next `icons:verify` acts on.
  const generatedOn =
    drifted.length > 0 || existing === null
      ? currentGeneratedOn()
      : existing.generatedOn;
  const lockWritten = writeIconsLock(rendered, generatedOn);

  console.log(
    drifted.length === 0
      ? `All ${rendered.length} icons already up to date.`
      : `Wrote ${drifted.length} of ${rendered.length} icons to public/icons/.`,
  );
  if (lockWritten) console.log("Updated assets/brand/icons.lock.json.");

  // Build mode ends with the same portable check the unit suite runs, so a
  // rebuild can never leave behind a state that `pnpm test` would reject.
  const problems = checkIconsLock();
  if (problems.length > 0) {
    reportLockProblems(problems);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    await runCheck();
    return;
  }
  await runBuild(process.argv.includes(ALLOW_FOREIGN_FLAG));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
