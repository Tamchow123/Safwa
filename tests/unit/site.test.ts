import { describe, expect, it } from "vitest";

import { siteConfig } from "@/lib/site";

describe("siteConfig", () => {
  it("uses the approved product name", () => {
    expect(siteConfig.name).toBe("Safwa");
    expect(siteConfig.title).toBe("Safwa");
  });

  it("uses the approved metadata description", () => {
    // PRODUCT_REQUIREMENTS/IMPLEMENTATION_PHASES Phase 1: metadata is
    // "Safwa" / "Arabic vocabulary and ṣarf learning".
    expect(siteConfig.description).toBe("Arabic vocabulary and ṣarf learning");
  });

  it("provides a non-empty tagline for the interim home page", () => {
    expect(siteConfig.tagline.length).toBeGreaterThan(0);
  });
});
