/**
 * SHA-256 helpers for the content build and Node-side tests.
 *
 * NODE-ONLY: imports node:crypto. Never import from browser code — the
 * client loader uses Web Crypto (see load.ts).
 */
import { createHash } from "node:crypto";

/** Lowercase-hex SHA-256 of the exact UTF-8 bytes of `text`. */
export function sha256HexUtf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
