"use client";

/**
 * Asking for a new verification email (Phase 18.3), shared by the verify page
 * and the sign-in page so the two cannot drift: the same normalised address,
 * the same `VERIFY_EMAIL_CALLBACK_URL`, the same learner-safe errors
 * (a 429 from the endpoint's own rate limit reads as "too many attempts").
 *
 * `sent` only means the request was accepted. The endpoint answers the same way
 * whether or not an unverified account exists for the address, so the copy
 * shown on success must not claim more — {@link RESEND_GENERIC_MESSAGE}.
 */
import { useState } from "react";

import { useAuthFormSubmit } from "@/components/auth/use-auth-form-submit";
import { sendVerificationEmail } from "@/modules/auth/client";
import { VERIFY_EMAIL_CALLBACK_URL } from "@/modules/auth/verification-links";

export const RESEND_GENERIC_MESSAGE =
  "If an account exists for that email and isn't verified yet, a new link is on its way.";

export function useResendVerification() {
  const [sent, setSent] = useState(false);
  const { pending, error, submit } = useAuthFormSubmit();

  async function resend(email: string) {
    await submit(
      () =>
        sendVerificationEmail({
          email: email.trim().toLowerCase(),
          callbackURL: VERIFY_EMAIL_CALLBACK_URL,
        }),
      () => setSent(true),
    );
  }

  return { sent, pending, error, resend };
}
