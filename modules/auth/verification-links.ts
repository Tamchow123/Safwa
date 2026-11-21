/**
 * Where an email-verification link lands (Phase 18.3).
 *
 * Better Auth's `GET /api/auth/verify-email` redirects to the `callbackURL`
 * unchanged on success and appends `error=<CODE>` on failure, joined with `&`
 * when the callback already carries a query string (verified against
 * better-auth 1.6.23, `dist/api/routes/email-verification.mjs`). Until 18.3 the
 * callback was the bare `/verify-email`, so the page read "no error" as
 * success, and anyone visiting it directly was told an email had been verified
 * when nothing had happened. The marker below makes success something only the
 * redirect can say.
 *
 * One constant for every caller that asks for a verification email — sign-up,
 * the verify page's resend and the sign-in page's resend — so a link lands the
 * same way whichever of them sent it.
 */

/** The query parameter that marks a real post-verification redirect. */
export const VERIFIED_PARAM = "verified";

/** The `callbackURL` every verification email is sent with. */
export const VERIFY_EMAIL_CALLBACK_URL = `/verify-email?${VERIFIED_PARAM}=1`;
