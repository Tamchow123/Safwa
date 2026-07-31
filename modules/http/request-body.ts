/**
 * Bounded request-body reading, shared by every authenticated sync endpoint
 * (phases-16.md §9.1, phases-17.md §29, §30).
 *
 * Extracted from `app/api/sync/push/route.ts` when the guest-merge route needed
 * the same guarantee. §13 says to reuse the Phase 16 server modules rather than
 * duplicate them, and this is exactly the kind of thing that must not be
 * copied: a second implementation is a second place for the cap to be wrong,
 * and the failure mode of getting it wrong is a route that buffers whatever it
 * is sent.
 *
 * `server-only`.
 */
import "server-only";

/** Sentinel returned when the body exceeds the hard byte cap. */
export const BODY_TOO_LARGE = Symbol("body-too-large");

/**
 * Read the request body as text with a HARD byte cap enforced against the
 * actual bytes received — not the client `Content-Length` header, which may be
 * absent, chunked, or understated. Aborts as soon as the running total exceeds
 * `maxBytes`, so an oversized body is never fully buffered. Returns the decoded
 * text, or {@link BODY_TOO_LARGE} when the cap is exceeded.
 */
export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<string | typeof BODY_TOO_LARGE> {
  const stream = request.body;
  if (!stream) {
    // No stream (e.g. an empty body); text() is safe and equally bounded here.
    const text = await request.text();
    return Buffer.byteLength(text, "utf8") > maxBytes ? BODY_TOO_LARGE : text;
  }
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return BODY_TOO_LARGE;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
