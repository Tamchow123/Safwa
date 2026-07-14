/**
 * Central site metadata. Kept framework-independent so it can be unit-tested
 * and reused by layouts, manifests and future PWA configuration.
 */
export const siteConfig = {
  name: "Safwa",
  title: "Safwa",
  description: "Arabic vocabulary and ṣarf learning",
  tagline: "Arabic vocabulary learning",
} as const;

export type SiteConfig = typeof siteConfig;
