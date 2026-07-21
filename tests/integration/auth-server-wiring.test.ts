import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { getAuth } from "@/modules/auth/server";

/**
 * Regression test for a bug that construction-only and config-shape checks
 * (tests/auth/server-config.test.ts, typecheck, build) all missed: the
 * drizzle adapter's schema map must be keyed by each entity's CONFIGURED
 * modelName ("users", "sessions", ...), not its base identifier ("user",
 * "session", ...) — a mismatch that only throws on an actual DB-touching
 * call, not on `betterAuth(...)` construction. Only manual browser testing
 * of the live registration flow caught it; this test exercises the same
 * real code path (getAuth().api.signUpEmail against the disposable
 * integration Postgres DB) so it can never regress silently again.
 */
describe("Better Auth drizzle adapter wiring", () => {
  it("signs up a user through the real Better Auth instance and persists a row", async () => {
    const email = `auth.wiring.${randomUUID()}@example.test`;

    const result = await getAuth().api.signUpEmail({
      body: {
        name: "Auth Wiring Test",
        email,
        password: "correct-horse-battery-staple",
      },
    });

    expect(result.user.email).toBe(email);

    const db = getDb();
    const [row] = await db.select().from(users).where(eq(users.email, email));
    expect(row).toBeDefined();
    expect(row?.emailVerified).toBe(false);
  });
});
