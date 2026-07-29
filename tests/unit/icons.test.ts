import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { iconUrl, siteConfig, SITE_ICONS } from "@/lib/site";
import {
  brandFillColours,
  buildIconsLock,
  checkIconsLock,
  ICONS_DIR,
  isForeignPlatform,
  masterFillColours,
  MASTER_SVG,
  readIconsLock,
} from "@/scripts/icons-lock";

/**
 * The icon set is generated and committed, which is only safe if a stale
 * commit is loud rather than silent — otherwise every unrelated branch picks
 * up a dirty working tree and people learn to `git checkout` the icons without
 * looking.
 *
 * This file deliberately does NOT re-render anything. `scripts/icons-lock.ts`
 * explains why in full: sharp ships a separately compiled native binary per
 * platform, so byte equality between a Windows-authored commit and a Linux CI
 * runner is a hope, not a guarantee, and gating the unit suite on it would
 * turn one bad day into a permanently red CI check. The exact re-render lives
 * in `pnpm icons:verify`, run by the quality gate on the authoring machine;
 * what runs here is the portable half, which is hermetic, sharp-free and
 * catches every drift that actually occurs.
 */
/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("the generated icon set", () => {
  it("has every file SITE_ICONS declares, at the declared size", () => {
    for (const spec of SITE_ICONS) {
      const { width, height } = pngSize(join(ICONS_DIR, spec.file));
      expect({ file: spec.file, width, height }).toEqual({
        file: spec.file,
        width: spec.size,
        height: spec.size,
      });
    }
  });

  it("builds a public URL under /icons for each", () => {
    expect(iconUrl("icon-192.png")).toBe("/icons/icon-192.png");
    for (const spec of SITE_ICONS) {
      expect(iconUrl(spec.file).startsWith("/icons/")).toBe(true);
    }
  });

  it("declares no duplicate file names", () => {
    const files = SITE_ICONS.map((spec) => spec.file);
    expect(new Set(files).size).toBe(files.length);
  });

  it("gives every square icon an alpha channel it does not need, and no more", () => {
    // PNG colour type: 2 is RGB, 6 is RGBA. Square exports are full-bleed, so
    // an alpha channel buys nothing and costs something real — iOS composites
    // a home-screen icon over BLACK rather than honouring transparency. The
    // rounded ones genuinely need it: their corners ARE transparent.
    for (const spec of SITE_ICONS) {
      const bytes = readFileSync(join(ICONS_DIR, spec.file));
      const colourType = bytes.readUInt8(25);
      expect({ file: spec.file, colourType }).toEqual({
        file: spec.file,
        colourType: spec.shape === "rounded" ? 6 : 2,
      });
    }
  });

  it("matches the lock: master, settings, declared set, digests, no strays", () => {
    // The one assertion that makes committing generated files safe. If it
    // fails, the message names which of those five things drifted — see
    // scripts/icons-lock.ts for what each failure means.
    expect(checkIconsLock()).toEqual([]);
  });

  it("records where the committed bytes came from, without asserting it", () => {
    // `generatedOn` is what lets `pnpm icons:verify` tell a real regression
    // apart from a cross-platform rasteriser difference, and what lets
    // `pnpm icons:build` refuse to re-bake the set from the wrong machine. It
    // is never asserted by checkIconsLock: doing so would make the lock invalid
    // everywhere except the machine that wrote it.
    const lock = readIconsLock();
    expect(lock.generatedOn.platform).toBeTruthy();
    expect(lock.generatedOn.arch).toBeTruthy();
    expect(lock.generatedOn.sharp).toContain("sharp");
    expect(checkIconsLock()).toEqual([]);
  });
});

describe("the foreign-platform guard", () => {
  const lock = readIconsLock();

  // Every case below synthesises the generatedOn it is testing rather than
  // relying on the committed one. That is not fussiness: the committed lock
  // names whichever machine last ran `pnpm icons:build`, so an assertion about
  // its platform would pass there and fail everywhere else — including on the
  // ubuntu runner that gates this repository. Non-portability in this file
  // specifically would undo the whole point of scripts/icons-lock.ts.

  it("does not fire when the lock names this platform and arch", () => {
    const sameMachine = {
      ...lock,
      generatedOn: {
        ...lock.generatedOn,
        platform: process.platform,
        arch: process.arch,
      },
    };
    expect(isForeignPlatform(sameMachine)).toBe(false);
  });

  it("fires on a different OS, and on the same OS with a different arch", () => {
    // Both halves matter: sharp resolves a separate compiled binary per
    // platform AND per architecture, so an arm64 Mac and an x64 Mac are as
    // much a mismatch as Windows and Linux.
    const foreignOs = {
      ...lock,
      generatedOn: { ...lock.generatedOn, platform: "somethingelse" },
    };
    const foreignArch = {
      ...lock,
      generatedOn: { ...lock.generatedOn, arch: "somethingelse" },
    };
    expect(isForeignPlatform(foreignOs)).toBe(true);
    expect(isForeignPlatform(foreignArch)).toBe(true);
  });

  it("lets generatedOn follow the bytes rather than the machine", () => {
    // buildIconsLock takes generatedOn as an argument instead of reading
    // process.platform itself, so a rebuild that renders nothing new can keep
    // the original provenance. Claiming this machine produced bytes it merely
    // re-verified would be a lie the next icons:verify acts on.
    const inherited = {
      platform: "linux",
      arch: "arm64",
      sharp: "sharp 0.0.0",
    };
    const rebuilt = buildIconsLock(lock.icons, inherited);
    expect(rebuilt.generatedOn).toEqual(inherited);
    expect(rebuilt.icons).toEqual(lock.icons);
    expect(rebuilt.master).toBe(lock.master);
  });
});

describe("the master mark", () => {
  it("uses exactly the two brand colours siteConfig declares", () => {
    // Three hand-maintained copies of one decision (app/globals.css's oklch
    // tokens, lib/site.ts's pinned hex, this file's fills) — this is the pair
    // with a live runtime coupling, because square icons are flattened over
    // siteConfig.themeColor while the field is drawn from the SVG's literal.
    const svg = readFileSync(MASTER_SVG, "utf8");
    expect(masterFillColours(svg)).toEqual(brandFillColours());
    expect(brandFillColours()).toEqual(
      [siteConfig.themeColor, siteConfig.backgroundColor].sort(),
    );
  });

  // The master is also asserted to be free of Arabic — that lives in
  // tests/unit/manifest.test.ts beside the same assertion for the manifest
  // itself, where the \u-escaped ranges are declared once.
});
