/**
 * Account settings API (Phase 15, phases-15.md §39) at
 * `/api/account/settings`. GET reads the caller's own settings (default
 * row implied, never someone else's — the row is always looked up by the
 * SESSION's own user id, never a client-supplied id). PUT merges a
 * partial update; unknown fields are stripped by the Zod schema (an
 * explicit field allowlist, not "whatever the client sends"). DELETE
 * resets to the documented defaults. Every response is either the
 * settings object or a fixed generic error string — never a raw
 * Zod/Drizzle error, stack trace, or SQL detail.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "@/modules/auth/session";
import {
  getAccountSettings,
  resetAccountSettings,
  upsertAccountSettings,
} from "@/modules/auth/account-settings";

export const runtime = "nodejs";

const timezoneSchema = z.union([
  z.object({ mode: z.literal("browser") }),
  z.object({ mode: z.literal("iana"), timezone: z.string() }),
]);

const sessionDefaultsSchema = z.object({
  questionCount: z.number(),
  optionCount: z.number(),
  newPerDay: z.number(),
  reviewsPerDay: z.number(),
});

// An explicit allowlist: every field is optional (PUT is a partial merge),
// and any field not named here is silently dropped by Zod's default
// object parsing, never forwarded to the settings module.
const patchSchema = z
  .object({
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

export async function GET(): Promise<NextResponse> {
  const session = await getServerSession();
  if (!session?.user) return unauthorized();

  const settings = await getAccountSettings(session.user.id);
  return NextResponse.json({ settings });
}

export async function PUT(request: Request): Promise<NextResponse> {
  const session = await getServerSession();
  if (!session?.user) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidBody();
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return invalidBody();

  const settings = await upsertAccountSettings(session.user.id, parsed.data);
  return NextResponse.json({ settings });
}

export async function DELETE(): Promise<NextResponse> {
  const session = await getServerSession();
  if (!session?.user) return unauthorized();

  const settings = await resetAccountSettings(session.user.id);
  return NextResponse.json({ settings });
}
