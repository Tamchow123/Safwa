import { describe, expect, it } from "vitest";

import { dynamic, dynamicParams, revalidate } from "@/app/serwist/[path]/route";

/**
 * The service-worker route's boundedness, asserted here rather than assumed.
 *
 * `/serwist/sw.js` is served with `Service-Worker-Allowed: /`, which lets a
 * worker on a subpath control the entire origin. That is only safe because the
 * route serves exactly the files `generateStaticParams` enumerates at build
 * time and nothing else — and every one of these values comes from
 * `@serwist/turbopack`'s own return object, not from this repository. A future
 * version that changed its defaults would widen what that header applies to,
 * and `pnpm sw:verify` would not notice: it reads build output, not
 * request-time behaviour.
 *
 * So the properties the header's safety rests on are pinned here — but only
 * those three, and they are half the claim. `dynamicParams: false` bounds the
 * route to the paths `generateStaticParams` enumerated; it says nothing about
 * what that set CONTAINS, and resolving it here is not possible (it runs a real
 * esbuild bundle over the built output). The other half is covered elsewhere:
 * `sw:verify`'s check `1b` asserts the emitted set is exactly the worker and
 * its source map, and slice 12's offline E2E requests an unemitted path against
 * a running server, which is the only way to see a real 404.
 */
describe("the /serwist/[path] route contract", () => {
  it("is fully prerendered, so esbuild never runs on a request", () => {
    expect(dynamic).toBe("force-static");
  });

  it("refuses paths it did not emit at build time", () => {
    // The one that matters. With `dynamicParams` true, an unenumerated segment
    // would be handled on demand instead of 404ing, under a header that grants
    // whatever it returns control of the whole origin.
    expect(dynamicParams).toBe(false);
  });

  it("never revalidates, because the output is fixed at build time", () => {
    expect(revalidate).toBe(false);
  });
});
