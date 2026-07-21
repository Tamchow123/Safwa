import { describe, expect, it } from "vitest";
import {
  getAccountSettings,
  resetAccountSettings,
  upsertAccountSettings,
} from "@/modules/auth/account-settings";
import { createTestUser } from "@/tests/integration/helpers/users";

/**
 * Regression test for a lost-update race two independent commit-council
 * reviewers (architecture, reliability) flagged: upsertAccountSettings
 * reads the current row, merges a patch onto it in application code, then
 * writes the whole row back. Without serializing concurrent writers for
 * the SAME user, two overlapping patches touching DIFFERENT field groups
 * could each read the same pre-write snapshot and the second to commit
 * would silently revert the first's already-saved change. The fix wraps
 * the read-merge-write in a transaction guarded by a
 * pg_advisory_xact_lock keyed on the user id (mirroring
 * db/register-content.ts's own concurrency pattern).
 */
describe("account settings concurrency", () => {
  it("never loses one of two concurrent disjoint-field patches for the same user", async () => {
    const userId = await createTestUser("Settings Race");

    const [themeResult, sessionDefaultsResult] = await Promise.all([
      upsertAccountSettings(userId, { theme: "dark" }),
      upsertAccountSettings(userId, {
        sessionDefaults: {
          questionCount: 42,
          optionCount: 3,
          newPerDay: 5,
          reviewsPerDay: 15,
        },
      }),
    ]);

    // Both requests must observe the finished result reflecting BOTH
    // changes — neither the theme change nor the session-defaults change
    // may have been silently reverted by the other's write.
    expect(themeResult.theme).toBe("dark");
    expect(sessionDefaultsResult.sessionDefaults.questionCount).toBe(42);

    const final = await getAccountSettings(userId);
    expect(final.theme).toBe("dark");
    expect(final.sessionDefaults).toEqual({
      questionCount: 42,
      optionCount: 3,
      newPerDay: 5,
      reviewsPerDay: 15,
    });
  });

  it("resetAccountSettings serializes against a concurrent upsert rather than being silently undone", async () => {
    const userId = await createTestUser("Settings Reset Race");
    await upsertAccountSettings(userId, { theme: "dark" });

    await Promise.all([
      resetAccountSettings(userId),
      upsertAccountSettings(userId, { arabicFontScale: "large" }),
    ]);

    // Whichever order the two transactions actually serialize in, theme
    // ends up "system" either way: if reset runs first, the upsert (which
    // never touches theme) reads and preserves that "system" value; if
    // the upsert runs first, reset's own write sets theme to "system"
    // last. Without the advisory-lock serialization, a stale read inside
    // the upsert's transaction could instead re-write theme back to the
    // pre-reset "dark" value, undoing the reset — this assertion would
    // then fail intermittently.
    const final = await getAccountSettings(userId);
    expect(final.theme).toBe("system");
  });

  it("upserts and reads only the caller's own row", async () => {
    const userA = await createTestUser("Settings User A");
    const userB = await createTestUser("Settings User B");

    await upsertAccountSettings(userA, { theme: "dark" });
    await upsertAccountSettings(userB, { theme: "light" });

    expect((await getAccountSettings(userA)).theme).toBe("dark");
    expect((await getAccountSettings(userB)).theme).toBe("light");
  });
});
