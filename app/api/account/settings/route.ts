/**
 * Account settings API (Phase 15, phases-15.md §39) at
 * `/api/account/settings`. GET reads the caller's own settings (default
 * row implied, never someone else's — the row is always looked up by the
 * SESSION's own user id, never a client-supplied id). PUT merges a
 * partial update; unknown fields, out-of-range numbers and unrecognised
 * timezone identifiers are REJECTED with 400 (`.strict()` schemas, an
 * explicit field allowlist, not "whatever the client sends, sanitised
 * quietly"). `modules/auth/account-settings.ts`'s own sanitize-on-read
 * fallback exists for a different reason (a legacy/corrupted stored row
 * must still degrade to a safe default) and is intentionally NOT relied on
 * here — an API returning 200 with silently-corrected data for a caller's
 * own malformed request is itself a bug the caller can never detect. DELETE
 * resets to the documented defaults. Every response is either the settings
 * object or a fixed generic error string — never a raw Zod/Drizzle error,
 * stack trace, or SQL detail.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { isValidTimezone } from "@/modules/profile/timezone";
import {
  verifySameOrigin,
  originHeadersOf,
} from "@/modules/http/request-origin";
import { getServerSession } from "@/modules/auth/session";
import { getServerEnv } from "@/modules/env/server";
import { consumeRateLimit } from "@/modules/http/rate-limit";
import { rateLimitedResponse } from "@/modules/http/rate-limited-response";
import { BODY_TOO_LARGE, readBoundedBody } from "@/modules/http/request-body";
import {
  getAccountSettings,
  resetAccountSettings,
  upsertAccountSettings,
} from "@/modules/auth/account-settings";
import { SESSION_DEFAULTS_BOUNDS } from "@/modules/profile/session-defaults";

export const runtime = "nodejs";

/**
 * The byte cap for a settings patch (Phase 18.1).
 *
 * Deliberately much smaller than `SYNC_BOUNDS.maxRequestBytes`: that limit
 * sizes a batch of learner events, and this body is at most four small fields.
 * Borrowing the sync number would have been a cap in name only.
 */
const MAX_SETTINGS_BODY_BYTES = 16_384;

const timezoneSchema = z.strictObject({ mode: z.literal("browser") }).or(
  z.strictObject({
    mode: z.literal("iana"),
    timezone: z.string().refine(isValidTimezone, "Unknown IANA timezone"),
  }),
);

function bounded(field: keyof typeof SESSION_DEFAULTS_BOUNDS) {
  const { min, max } = SESSION_DEFAULTS_BOUNDS[field];
  return z.number().int().min(min).max(max);
}

// Only the FOUR top-level groups (theme/arabicFontScale/timezone/
// sessionDefaults) are independently optional for a partial PUT.
// sessionDefaults itself is all-or-nothing when present — a caller
// wanting to change one study-default field must resend the whole
// group. This matches how components/account/account-settings-form.tsx
// always sends its full in-memory settings object; a field-level-partial
// sessionDefaults contract isn't needed by any current caller. Bounds
// mirror SESSION_DEFAULTS_BOUNDS exactly — the same source the client UI
// uses for its own min/max attributes — so a value the UI would refuse to
// submit can never arrive here through some other caller either.
const sessionDefaultsSchema = z.strictObject({
  questionCount: bounded("questionCount"),
  optionCount: bounded("optionCount"),
  newPerDay: bounded("newPerDay"),
  reviewsPerDay: bounded("reviewsPerDay"),
});

// An explicit allowlist: every field is optional (PUT is a partial merge),
// and `.strict()` REJECTS (not silently drops) any field not named here.
const patchSchema = z
  .strictObject({
    theme: z.enum(["light", "dark", "system"]),
    arabicFontScale: z.enum(["small", "default", "large"]),
    timezone: timezoneSchema,
    sessionDefaults: sessionDefaultsSchema,
  })
  .partial();

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function invalidBody(): NextResponse {
  return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
}

/**
 * Origin, then session, then rate limit, in that order (Phase 18.1).
 *
 * The order is the point. The origin check is cheapest and needs no database,
 * so a request from another site is refused before anything is read. The rate
 * limit is counted LAST, after the session, so it is keyed by an account id
 * the server derived rather than anything the caller supplied — and so an
 * unauthenticated caller cannot fill the counter table on someone else's
 * behalf.
 *
 * All three handlers below are authenticated and all three touch the database,
 * so all three are limited — including GET. A read is cheaper than a write but
 * it is not free, and leaving one verb unlimited would just move a loop onto
 * it.
 *
 * Returns either the authorised user id or the response to send instead.
 */
async function authorise(
  request: Request,
): Promise<
  { ok: true; userId: string } | { ok: false; response: NextResponse }
> {
  // Same-origin first, before the session is read (Phase 18.1). The cookie is
  // SameSite=Lax, so a cross-site PUT/DELETE already arrives without one — but
  // GET is reachable by a top-level navigation from another origin, and this
  // refuses that rather than relying on the response being unreadable.
  const verdict = verifySameOrigin(
    originHeadersOf(request),
    new URL(getServerEnv().appUrl).origin,
  );
  if (!verdict.sameOrigin) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Request origin not allowed." },
        { status: 403 },
      ),
    };
  }

  const session = await getServerSession();
  if (!session?.user) return { ok: false, response: unauthorized() };

  const limit = await consumeRateLimit("account-settings", session.user.id);
  if (!limit.allowed) {
    return {
      ok: false,
      response: rateLimitedResponse(limit.retryAfterSeconds),
    };
  }
  return { ok: true, userId: session.user.id };
}

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await authorise(request);
  if (!auth.ok) return auth.response;

  const settings = await getAccountSettings(auth.userId);
  return NextResponse.json({ settings });
}

export async function PUT(request: Request): Promise<NextResponse> {
  const auth = await authorise(request);
  if (!auth.ok) return auth.response;

  // Bound the body before parsing it (Phase 18.1), the same way the three sync
  // routes do. The strict schema below would reject anything oversized anyway,
  // but only AFTER `JSON.parse` had already buffered and walked it — which is
  // the cost this route was just given a rate limit to bound. A settings patch
  // is four small fields; the cap is orders of magnitude above any legitimate
  // one, so it can only ever catch something that was never going to be valid.
  const text = await readBoundedBody(request, MAX_SETTINGS_BODY_BYTES);
  if (text === BODY_TOO_LARGE) {
    return NextResponse.json({ error: "Request too large." }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return invalidBody();
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return invalidBody();

  const settings = await upsertAccountSettings(auth.userId, parsed.data);
  return NextResponse.json({ settings });
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const auth = await authorise(request);
  if (!auth.ok) return auth.response;

  const settings = await resetAccountSettings(auth.userId);
  return NextResponse.json({ settings });
}
