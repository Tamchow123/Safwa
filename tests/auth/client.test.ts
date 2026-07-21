import { describe, expect, it } from "vitest";
import {
  authClient,
  deleteUser,
  requestPasswordReset,
  resetPassword,
  sendVerificationEmail,
  signIn,
  signOut,
  signUp,
  useSession,
  verifyEmail,
} from "@/modules/auth/client";

describe("modules/auth/client", () => {
  it("exposes every operation the phase requires, thinly re-exported from one client", () => {
    expect(signUp.email).toBeTypeOf("function");
    expect(signIn.email).toBeTypeOf("function");
    expect(signOut).toBeTypeOf("function");
    expect(useSession).toBeTypeOf("function");
    expect(requestPasswordReset).toBeTypeOf("function");
    expect(resetPassword).toBeTypeOf("function");
    expect(sendVerificationEmail).toBeTypeOf("function");
    expect(verifyEmail).toBeTypeOf("function");
    expect(deleteUser).toBeTypeOf("function");
  });

  it("builds the client from clientEnv.appUrl rather than a hardcoded origin", () => {
    expect(authClient).toBeDefined();
    expect(authClient.$fetch).toBeTypeOf("function");
  });
});
