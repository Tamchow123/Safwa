/**
 * Better Auth API mount point (Phase 15, phases-15.md §31) at
 * `/api/auth/[...all]`. Checks `AUTH_ENABLED` BEFORE ever calling
 * `getAuth()` as a fast path that returns a clean 503 without a
 * throw/catch — `getAuth()` itself (modules/auth/server.ts) ALSO refuses
 * to construct when disabled, throwing `AuthDisabledError`, so this
 * check is a UX optimisation layered on that guarantee, not the sole
 * enforcement of it.
 *
 * Only GET/POST are exported: every currently-enabled feature
 * (email/password, mandatory verification, password reset, self-service
 * deletion, session) uses only these two methods. `toNextJsHandler` also
 * exposes PATCH/PUT/DELETE for features (e.g. OAuth account linking) this
 * app does not enable — exporting them would be a route surface with no
 * real handler behind it.
 */
import { NextResponse } from "next/server";
import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/modules/auth/server";
import { getServerEnv } from "@/modules/env/server";

export const runtime = "nodejs";

/**
 * Time budget (Phase 18.2). Email delivery is scheduled with `after()`
 * (modules/email/dispatch.ts), which runs inside THIS function's lifetime once
 * the response has been sent — so a verification, reset or delete-account
 * email gets only what is left of this route's budget to finish its SMTP
 * exchange (`SMTP_SEND_TIMEOUT_MS`). Left to the platform default (Phase 18.1
 * recorded Vercel's as 10s, no more than the send bound itself), a slow request
 * followed by a slow handshake would be killed mid-send, and the learner would
 * simply never receive the email: nothing reports it.
 *
 * 60s, the same as the sync routes and valid on every Vercel plan. Must be a
 * literal for the same reason as theirs: Next reads route segment config by
 * static analysis, so an imported constant would be ignored.
 */
export const maxDuration = 60;

function authUnavailableResponse(): Response {
  return NextResponse.json(
    { error: "Authentication is currently unavailable." },
    { status: 503 },
  );
}

export async function GET(request: Request): Promise<Response> {
  if (!getServerEnv().authEnabled) {
    return authUnavailableResponse();
  }
  return toNextJsHandler(getAuth()).GET(request);
}

export async function POST(request: Request): Promise<Response> {
  if (!getServerEnv().authEnabled) {
    return authUnavailableResponse();
  }
  return toNextJsHandler(getAuth()).POST(request);
}
