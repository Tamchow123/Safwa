import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getAuth } from "@/modules/auth/server";
import { TEST_PASSWORD as PASSWORD } from "@/tests/integration/helpers/auth-session";

/**
 * Enumeration-safety integration suite (phases-15.md §60): registration,
 * password-reset requests and login errors must all be structurally
 * identical whether or not the target account actually exists.
 */
describe("auth: enumeration safety", () => {
  it("registration returns the same shape for a new email and an already-registered one", async () => {
    const email = `enum.register.${randomUUID()}@example.test`;
    await getAuth().api.signUpEmail({
      body: { name: "Existing", email, password: PASSWORD },
    });

    const forExisting = await getAuth().api.signUpEmail({
      body: { name: "Existing Again", email, password: "another-password-1" },
    });
    const forNew = await getAuth().api.signUpEmail({
      body: {
        name: "Genuinely New",
        email: `enum.register.new.${randomUUID()}@example.test`,
        password: "another-password-1",
      },
    });

    expect(Object.keys(forExisting).sort()).toEqual(Object.keys(forNew).sort());
    expect(forExisting.token).toBeNull();
    expect(forNew.token).toBeNull();
  });

  it("requestPasswordReset returns the same generic response for a real and a nonexistent email", async () => {
    const email = `enum.reset.${randomUUID()}@example.test`;
    await getAuth().api.signUpEmail({
      body: { name: "Reset Target", email, password: PASSWORD },
    });

    const forReal = await getAuth().api.requestPasswordReset({
      body: { email },
    });
    const forFake = await getAuth().api.requestPasswordReset({
      body: { email: `enum.reset.nonexistent.${randomUUID()}@example.test` },
    });

    expect(forReal).toEqual(forFake);
    expect(forReal.status).toBe(true);
  });

  it("login rejects an unknown email and a wrong password with the identical error code", async () => {
    const email = `enum.login.${randomUUID()}@example.test`;
    await getAuth().api.signUpEmail({
      body: { name: "Login Target", email, password: PASSWORD },
    });

    const wrongPassword = await getAuth()
      .api.signInEmail({ body: { email, password: "totally-wrong" } })
      .catch((error: unknown) => error);
    const unknownEmail = await getAuth()
      .api.signInEmail({
        body: {
          email: `enum.login.nonexistent.${randomUUID()}@example.test`,
          password: "totally-wrong",
        },
      })
      .catch((error: unknown) => error);

    // Full status + body comparison (not just `code`), matching the
    // toEqual-based proof already used above for signUpEmail and
    // requestPasswordReset — a differing message/body field would still be
    // a real enumeration oracle even with an identical `code`.
    const shapeOf = (error: unknown): unknown => {
      const e = error as { status?: unknown; body?: unknown };
      return { status: e?.status, body: e?.body };
    };
    expect(
      (shapeOf(wrongPassword) as { body?: { code?: unknown } }).body?.code,
    ).toBeDefined();
    expect(shapeOf(wrongPassword)).toEqual(shapeOf(unknownEmail));
  });
});
