/**
 * Central site metadata. Kept framework-independent so it can be unit-tested
 * and reused by layouts, manifests and future PWA configuration.
 */
export const siteConfig = {
  name: "Safwa",
  title: "Safwa",
  description: "Arabic vocabulary and ṣarf learning",
  tagline: "Arabic vocabulary learning",
  /**
   * Home-screen label (Phase 18). Android and iOS truncate around 12
   * characters, so this exists to be short even though it currently equals
   * `name` — a later rename must not silently produce a clipped label.
   */
  shortName: "Safwa",
  /**
   * Brand colours, as sRGB hex.
   *
   * These are the app's own `--primary` and `--background` light-theme tokens
   * from `app/globals.css`, converted from oklch once and pinned here. A web
   * manifest takes a single colour, with no light/dark variant and no oklch
   * support across consumers, so the conversion has to live somewhere; this is
   * that place, and `assets/brand/safwa-mark.svg` carries the same two
   * literals so the icon and the manifest cannot drift apart.
   *
   * `themeColor` tints the OS chrome around an installed window;
   * `backgroundColor` is what a launcher paints during the cold-start splash,
   * before any of the app's CSS has run — hence the light value, which matches
   * an unstyled first paint rather than fighting it.
   */
  themeColor: "#005b44",
  backgroundColor: "#fbfaf7",
} as const;

export type SiteConfig = typeof siteConfig;

export type IconSpec = {
  /** File name under `public/icons/`. */
  file: string;
  size: number;
  /**
   * `square` is the raw export: a maskable icon (Android crops it to the
   * launcher's shape) or an Apple touch icon (iOS rounds it itself and
   * composites over black, so transparency would bleed). `rounded` is for an
   * icon drawn exactly as given, where a bare square looks unfinished beside
   * the icons around it.
   */
  shape: "square" | "rounded";
};

/**
 * Every icon this project ships, in one list.
 *
 * It lives HERE, in a dependency-free module, rather than in
 * `scripts/generate-icons.ts` beside the code that renders it — because the
 * generator imports `sharp`, and `app/manifest.ts` and the unit tests must be
 * able to read this list without pulling a native image library into a Next
 * build or a jsdom test run. The generator imports it in the other direction.
 */
export const SITE_ICONS: readonly IconSpec[] = [
  { file: "icon-192.png", size: 192, shape: "rounded" },
  { file: "icon-512.png", size: 512, shape: "rounded" },
  { file: "icon-maskable-192.png", size: 192, shape: "square" },
  { file: "icon-maskable-512.png", size: 512, shape: "square" },
  { file: "apple-touch-icon.png", size: 180, shape: "square" },
  { file: "favicon-32.png", size: 32, shape: "square" },
  { file: "favicon-16.png", size: 16, shape: "square" },
] as const;

/** Public URL of a generated icon. */
export function iconUrl(file: string): string {
  return `/icons/${file}`;
}
