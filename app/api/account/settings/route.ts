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
import { getServerSession } from "@/modules/auth/session";
import {
  consumeRateLimit,
  RATE_LIMITED_ERROR,
} from "@/modules/sync/server/rate-limit";
import {
  getAccountSettings,
  resetAccountSettings,
  upsertAccountSettings,
} from "@/modules/auth/account-settings";
import { SESSION_DEFAULTS_BOUNDS } from "@/modules/profile/session-defaults";

export const runtime = "nodejs";

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
 * Session, then rate limit, in that order (Phase 18.1).
 *
 * All three handlers below are authenticated and all three touch the database,
 * so all three are limited — including GET. A read is cheaper than a write but
 * it is not free, and leaving one verb unlimited would just move a loop onto
 * it.
 *
 * The limit is counted AFTER the session check, so it is keyed by an account
 * id the server derived rather than anything the caller supplied, and an
 * unauthenticated caller cannot fill the counter table on someone else's
 * behalf.
 *
 * Returns either the authorised user id or the response to send instead.
 */
async function authorise(): Promise<
  { ok: true; userId: string } | { ok: false; response: NextResponse }
> {
  const session = await getServerSession();
  if (!session?.user) return { ok: false, response: unauthorized() };

  const limit = await consumeRateLimit("account-settings", session.user.id);
  if (!limit.allowed) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: RATE_LIMITED_ERROR },
        {
          status: 429,
          headers: { "Retry-After": String(limit.retryAfterSeconds) },
        },
      ),
    };
  }
  return { ok: true, userId: session.user.id };
}

export async function GET(): Promise<NextResponse> {
  const auth = await authorise();
  if (!auth.ok) return auth.response;

  const settings = await getAccountSettings(auth.userId);
  return NextResponse.json({ settings });
}

export async function PUT(request: Request): Promise<NextResponse> {
  const auth = await authorise();
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidBody();
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return invalidBody();

  const settings = await upsertAccountSettings(auth.userId, parsed.data);
  return NextResponse.json({ settings });
}

export async function DELETE(): Promise<NextResponse> {
  const auth = await authorise();
  if (!auth.ok) return auth.response;

  const settings = await resetAccountSettings(auth.userId);
  return NextResponse.json({ settings });
}
