import type { NextConfig } from "next";

/**
 * A referrer policy, set explicitly rather than left to the browser default
 * (Phase 17 §11, SEC-202-T6b).
 *
 * Several of this app's flows put a single-use secret in a URL: Better Auth's
 * verification, password-reset and delete-account links, and the deletion
 * callback's own nonce (`components/account/pending-account-deletion.ts`). Any
 * cross-origin subresource loaded while such a URL is current would otherwise
 * be able to receive it in a `Referer` header. Modern browsers default to this
 * value, but a default is not a guarantee, and the pages carrying those secrets
 * are exactly the ones where it must not be one.
 */
const REFERRER_POLICY = "strict-origin-when-cross-origin";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Referrer-Policy", value: REFERRER_POLICY }],
      },
    ];
  },
};

export default nextConfig;
