/**
 * Browser SHA-256 (Web Crypto). Separate module so both the cache layer
 * (db.ts) and the loader (load.ts) can verify bytes without a circular
 * dependency. Node contexts use modules/content/checksum.ts instead.
 */

/** Lowercase-hex SHA-256 of the exact UTF-8 bytes of `text`. */
export async function sha256HexBrowser(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
