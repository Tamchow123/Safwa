"use client";

/**
 * Shared async-submit state for auth forms (Phase 15). Every form that
 * calls a Better Auth client method (register, login, resend, forgot/reset
 * password) follows the identical shape: guard against a double-submit,
 * clear the previous error, run the call, map a returned `error` or a
 * thrown exception to a learner-safe message, always clear the pending
 * flag. Centralising it here (rather than repeating it per form, per the
 * clean-code review that flagged the duplication once a third form
 * repeated the pattern) keeps that shape — and its ordering — in one
 * place.
 */
import { useState } from "react";
import { toLearnerSafeMessage } from "@/modules/auth/errors";

type AuthResult = { error?: unknown } | null | undefined;

export function useAuthFormSubmit() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(
    action: () => Promise<AuthResult>,
    onSuccess: () => void,
  ) {
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      const result = await action();
      if (result?.error) {
        setError(toLearnerSafeMessage(result.error));
        return;
      }
      onSuccess();
    } catch {
      setError(toLearnerSafeMessage(null));
    } finally {
      setPending(false);
    }
  }

  return { pending, error, setError, submit };
}
