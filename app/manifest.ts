import type { MetadataRoute } from "next";

import { iconUrl, siteConfig, SITE_ICONS } from "@/lib/site";

/**
 * Next's own icon-entry type, taken from the manifest type rather than
 * restated — so a future Next upgrade that changes the shape is a typecheck
 * failure here rather than a silently wrong manifest.
 */
type ManifestIcon = NonNullable<MetadataRoute.Manifest["icons"]>[number];

/** A manifest icon entry built from the generated set, never a bare literal. */
function icon(file: string, purpose: "any" | "maskable"): ManifestIcon {
  const spec = SITE_ICONS.find((candidate) => candidate.file === file);
  if (!spec) {
    // Unreachable while the names below match SITE_ICONS, and a build-time
    // throw is the right failure: a manifest that silently ships an icon
    // nobody generates is an install prompt that silently never appears.
    throw new Error(`manifest: no generated icon named "${file}"`);
  }
  return {
    src: iconUrl(spec.file),
    sizes: `${spec.size}x${spec.size}`,
    type: "image/png",
    purpose,
  };
}

/**
 * The web app manifest (Phase 18), served by Next at
 * `/manifest.webmanifest` — the file convention, not a hand-written JSON in
 * `public/`, so `siteConfig` stays the single source of the app's name and
 * brand colours instead of a second copy that can drift.
 *
 * Every field here is load-bearing for installability. phases-18.md §10
 * records why that is asserted directly in Playwright rather than by
 * Lighthouse: Lighthouse removed its PWA category in v12, so the checkpoint
 * as originally written is not automatable by any current version. The
 * criteria it used to assert are checked explicitly instead — name,
 * short_name, start_url, display, an icon at 192 and one at 512, and every
 * declared icon URL actually reachable.
 *
 * `id` is set explicitly. Without it a browser derives the app's identity
 * from `start_url`, so changing `start_url` later would orphan every existing
 * installation into a second, unrelated app.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: siteConfig.name,
    short_name: siteConfig.shortName,
    description: siteConfig.description,
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: siteConfig.backgroundColor,
    theme_color: siteConfig.themeColor,
    categories: ["education"],
    lang: "en",
    // `dir: "ltr"` is correct and is NOT a statement about the vocabulary.
    // The app's chrome — navigation, buttons, this manifest's own strings — is
    // English and left-to-right. Arabic content is rendered right-to-left by
    // the components that display it (components/arabic-text.tsx), which is
    // where that decision belongs.
    dir: "ltr",
    icons: [
      // `any` and `maskable` are deliberately separate files rather than one
      // entry declaring both purposes. A single icon cannot satisfy both well:
      // a maskable icon is full-bleed and loses its outer ~20% to whatever
      // shape the launcher crops to, while an `any` icon is drawn exactly as
      // given. Declaring one file as both means it is either padded and small
      // when unmasked, or clipped when masked.
      icon("icon-192.png", "any"),
      icon("icon-512.png", "any"),
      icon("icon-maskable-192.png", "maskable"),
      icon("icon-maskable-512.png", "maskable"),
    ],
  };
}
