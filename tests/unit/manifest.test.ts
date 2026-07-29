import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import manifest from "@/app/manifest";
import { siteConfig, SITE_ICONS } from "@/lib/site";

/**
 * The manifest is the difference between "a website" and "an app you can
 * install", and every assertion below is one of the criteria phases-18.md §10
 * lists after recording that Lighthouse removed its PWA category in v12 and
 * can no longer check them for us.
 *
 * The reason this is a unit test and not only an E2E one: an E2E check proves
 * the manifest a running server served, which is the right proof and arrives
 * in slice 12. This one fails in a second, on the machine of whoever broke it,
 * and covers the case that matters most — a declared icon path that no longer
 * exists on disk, which is invisible until an install prompt silently stops
 * appearing.
 */
const PUBLIC_DIR = join(process.cwd(), "public");

describe("app/manifest.ts", () => {
  const value = manifest();

  it("declares the four fields an installable manifest must have", () => {
    expect(value.name).toBe(siteConfig.name);
    expect(value.short_name).toBe(siteConfig.shortName);
    expect(value.start_url).toBe("/");
    expect(value.display).toBe("standalone");
  });

  it("pins an explicit id, so a later start_url change cannot orphan installs", () => {
    // Without `id`, identity is derived from start_url: changing start_url
    // would make every existing installation a different, stale app.
    expect(value.id).toBe("/");
  });

  it("declares at least one icon >=192px and one >=512px", () => {
    const edges = (value.icons ?? []).map((icon) =>
      Number.parseInt(String(icon.sizes).split("x")[0] ?? "0", 10),
    );
    expect(edges.some((edge) => edge >= 192)).toBe(true);
    expect(edges.some((edge) => edge >= 512)).toBe(true);
  });

  it("ships separate any and maskable icons, not one file claiming both", () => {
    // A maskable icon loses its outer ~20% to the launcher's crop; an `any`
    // icon is drawn exactly as given. One file cannot be right for both.
    const purposes = (value.icons ?? []).map((icon) => icon.purpose);
    expect(purposes).toContain("any");
    expect(purposes).toContain("maskable");
    for (const purpose of purposes) {
      expect(String(purpose).split(" ")).toHaveLength(1);
    }
  });

  it("every declared icon exists on disk at the size it claims", () => {
    // The failure this catches: a manifest that promises an icon nobody
    // generates. Nothing else in the build would notice — the manifest still
    // serves, the install prompt just never appears.
    for (const icon of value.icons ?? []) {
      const relative = String(icon.src).replace(/^\//, "");
      const file = join(PUBLIC_DIR, relative);
      expect(existsSync(file), `${icon.src} is declared but missing`).toBe(
        true,
      );

      const generated = SITE_ICONS.find(
        (spec) => `/icons/${spec.file}` === icon.src,
      );
      expect(
        generated,
        `${icon.src} is not produced by scripts/generate-icons.ts`,
      ).toBeDefined();
      expect(icon.sizes).toBe(`${generated?.size}x${generated?.size}`);
    }
  });

  it("every declared icon is a real PNG, not a placeholder", () => {
    // A zero-byte or text placeholder would satisfy existsSync and still fail
    // to install, so check the actual PNG signature and IHDR dimensions.
    for (const icon of value.icons ?? []) {
      const bytes = readFileSync(
        join(PUBLIC_DIR, String(icon.src).replace(/^\//, "")),
      );
      expect([...bytes.subarray(0, 8)]).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      expect(`${width}x${height}`).toBe(icon.sizes);
    }
  });

  it("carries the brand colours from siteConfig, not its own copies", () => {
    expect(value.theme_color).toBe(siteConfig.themeColor);
    expect(value.background_color).toBe(siteConfig.backgroundColor);
  });

  it("declares ltr, which is about the app chrome and not the vocabulary", () => {
    // Arabic content is rendered right-to-left by the components that display
    // it; the manifest's own strings are English.
    expect(value.dir).toBe("ltr");
  });

  it("contains no Arabic text (hard rule 3 is satisfied by avoidance here)", () => {
    // There is no source dataset for a brand word, so nothing in the manifest
    // — or in the mark it points at — may contain an Arabic string, which
    // could only have got there by being hand-typed.
    //
    // The ranges are written as \u escapes, not as literal characters: rule 3
    // is explicit that Arabic in source must be ASCII-safe, and a literal
    // range here would be exactly the kind of hand-typed Arabic it forbids.
    // U+0600-06FF Arabic, U+0750-077F Supplement, U+08A0-08FF Extended-A,
    // U+FB50-FDFF Presentation Forms-A, U+FE70-FEFF Forms-B.
    const arabic =
      /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
    expect(arabic.test(JSON.stringify(value))).toBe(false);

    const mark = readFileSync(
      join(process.cwd(), "assets", "brand", "safwa-mark.svg"),
      "utf8",
    );
    expect(arabic.test(mark)).toBe(false);
  });
});
