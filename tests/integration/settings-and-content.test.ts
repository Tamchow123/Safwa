import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import {
  contentVersions,
  dailyActivity,
  guestImports,
  userSettings,
} from "@/db/schema";
import { createTestUser } from "@/tests/integration/helpers/users";

const VALID_HEX64 = "a".repeat(64);

function contentVersionRow(
  overrides: Partial<typeof contentVersions.$inferInsert> = {},
) {
  return {
    releaseId: overrides.releaseId ?? `release-${randomUUID()}`,
    contentVersion: "1.0.0",
    schemaVersion: "1.0.0",
    questionGeneratorVersion: "1",
    entryCount: 455,
    checksumLearner: VALID_HEX64,
    checksumValidation: VALID_HEX64,
    checksumAssessment: VALID_HEX64,
    releaseStatus: "supported",
    minimumSupportedClientVersion: "0.1.0",
    minimumSupportedEventSchema: 1,
    ...overrides,
  };
}

describe("daily_activity constraint integration", () => {
  it("rejects a duplicate (user_id, local_date) row", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await db.insert(dailyActivity).values({ userId, localDate: "2026-01-01" });
    await expect(
      db.insert(dailyActivity).values({ userId, localDate: "2026-01-01" }),
    ).rejects.toThrow();
  });

  it("allows the same local_date for two different users", async () => {
    const db = getDb();
    const userA = await createTestUser();
    const userB = await createTestUser();
    await expect(
      db
        .insert(dailyActivity)
        .values({ userId: userA, localDate: "2026-01-01" }),
    ).resolves.toBeDefined();
    await expect(
      db
        .insert(dailyActivity)
        .values({ userId: userB, localDate: "2026-01-01" }),
    ).resolves.toBeDefined();
  });
});

describe("user_settings constraint integration", () => {
  it("enforces one row per user", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await db.insert(userSettings).values({ userId });
    await expect(db.insert(userSettings).values({ userId })).rejects.toThrow();
  });

  it("rejects an out-of-bounds question_count", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await expect(
      db.insert(userSettings).values({ userId, questionCount: 0 }),
    ).rejects.toThrow();
    await expect(
      db.insert(userSettings).values({ userId, questionCount: 101 }),
    ).rejects.toThrow();
  });

  it("rejects browser timezone_mode with a non-NULL timezone_name", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await expect(
      db.insert(userSettings).values({
        userId,
        timezoneMode: "browser",
        timezoneName: "Asia/Dubai",
      }),
    ).rejects.toThrow();
  });

  it("rejects iana timezone_mode with a NULL timezone_name", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await expect(
      db.insert(userSettings).values({ userId, timezoneMode: "iana" }),
    ).rejects.toThrow();
  });

  it("accepts a valid iana timezone shape", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await expect(
      db.insert(userSettings).values({
        userId,
        timezoneMode: "iana",
        timezoneName: "Asia/Dubai",
      }),
    ).resolves.toBeDefined();
  });
});

describe("guest_imports constraint integration", () => {
  it("rejects a duplicate import_key (idempotency anchor)", async () => {
    const db = getDb();
    const userId = await createTestUser();
    const importKey = randomUUID();
    await db.insert(guestImports).values({
      userId,
      deviceId: "device-1",
      importKey,
      snapshotHash: "a".repeat(64),
    });
    await expect(
      db.insert(guestImports).values({
        userId,
        deviceId: "device-1",
        importKey,
        snapshotHash: "b".repeat(64),
      }),
    ).rejects.toThrow();
  });

  it("refuses the same import key to a DIFFERENT account (§15)", async () => {
    // The uniqueness is GLOBAL, not per-user, which is what makes "an import
    // key cannot be claimed across accounts" a database invariant rather than a
    // check the coordinator has to remember: a key names at most one row, and
    // that row names one account.
    const db = getDb();
    const mine = await createTestUser();
    const theirs = await createTestUser();
    const importKey = randomUUID();
    await db.insert(guestImports).values({
      userId: mine,
      deviceId: "device-1",
      importKey,
      snapshotHash: "a".repeat(64),
    });
    await expect(
      db.insert(guestImports).values({
        userId: theirs,
        deviceId: "device-2",
        importKey,
        snapshotHash: "a".repeat(64),
      }),
    ).rejects.toThrow();
  });

  it("records an INCOMPLETE finalisation without calling it a terminal failure", async () => {
    // §29: after a partial merge, neither "succeeded" nor "rolled back" is
    // honest. The row therefore stays `open` — so the client resumes under the
    // same key — while `result` records that finalisation was attempted and
    // could not conclude. The Phase-15 three-value vocabulary could not express
    // this and would have forced `rejected`, claiming a failure that never
    // happened.
    const db = getDb();
    const userId = await createTestUser();
    await expect(
      db.insert(guestImports).values({
        userId,
        deviceId: "device-1",
        importKey: randomUUID(),
        snapshotHash: "a".repeat(64),
        status: "open",
        result: "incomplete",
        acceptedItems: 400,
        nextChunkIndex: 2,
      }),
    ).resolves.toBeDefined();
  });

  it("rejects a result outside the merge vocabulary", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await expect(
      db.insert(guestImports).values({
        userId,
        deviceId: "device-1",
        importKey: randomUUID(),
        snapshotHash: "a".repeat(64),
        result: "partially_applied",
      }),
    ).rejects.toThrow();
  });

  it("refuses a concluded import that does not say how it concluded", async () => {
    // A completed merge and an abandoned one must never be indistinguishable
    // (§15 — partial processing cannot be mistaken for completed success).
    const db = getDb();
    const userId = await createTestUser();
    await expect(
      db.insert(guestImports).values({
        userId,
        deviceId: "device-1",
        importKey: randomUUID(),
        snapshotHash: "a".repeat(64),
        status: "completed",
        completedAt: new Date(),
        // result deliberately omitted
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(guestImports).values({
        userId,
        deviceId: "device-1",
        importKey: randomUUID(),
        snapshotHash: "a".repeat(64),
        status: "completed",
        result: "applied",
        // completedAt deliberately omitted
      }),
    ).rejects.toThrow();
  });

  it("refuses an OPEN import that claims a completion time", async () => {
    const db = getDb();
    const userId = await createTestUser();
    await expect(
      db.insert(guestImports).values({
        userId,
        deviceId: "device-1",
        importKey: randomUUID(),
        snapshotHash: "a".repeat(64),
        status: "open",
        completedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it("lets one account complete a given snapshot only ONCE, while retries stay legal", async () => {
    // §15's "the same successful import resubmitted is a no-op" as a database
    // invariant: even a client that mints a fresh key for a snapshot it already
    // merged cannot record a second completion, so the same history cannot be
    // applied twice under two keys. The index is partial, so abandoned and
    // in-flight attempts at the same snapshot are unaffected.
    const db = getDb();
    const userId = await createTestUser();
    const snapshotHash = "c".repeat(64);
    const completed = {
      userId,
      deviceId: "device-1",
      snapshotHash,
      status: "completed",
      completedAt: new Date(),
      result: "applied",
      // A concluded import says WHY it concluded (0005).
      reasonCode: "already_completed",
    } as const;

    await db
      .insert(guestImports)
      .values({ ...completed, importKey: randomUUID() });
    // A second COMPLETED import of the same snapshot: refused.
    await expect(
      db.insert(guestImports).values({ ...completed, importKey: randomUUID() }),
    ).rejects.toThrow();
    // An open attempt at the same snapshot: still allowed.
    await expect(
      db.insert(guestImports).values({
        userId,
        deviceId: "device-1",
        importKey: randomUUID(),
        snapshotHash,
      }),
    ).resolves.toBeDefined();
  });

  it("refuses every status/result pairing the design never sanctions", async () => {
    // Splitting lifecycle from outcome only helps if the two cannot contradict
    // each other. A check that merely required "some result once concluded"
    // would still admit an 'open' row carrying a terminal outcome — a reader
    // following status resumes the import while a reader following result tells
    // the learner it finished. Three reviewers independently found that gap.
    const db = getDb();
    const userId = await createTestUser();
    const base = {
      userId,
      deviceId: "device-1",
      snapshotHash: "a".repeat(64),
    };
    // Every row below carries a valid reasonCode, so the terminal-reason
    // constraint added in 0005 cannot be what rejects them — the status/result
    // pairing has to be, which is what this test is about.
    const illegal = [
      // A terminal outcome recorded while the lifecycle says still running.
      {
        status: "open",
        result: "applied",
        completedAt: null,
        reasonCode: "internal_error",
      },
      {
        status: "open",
        result: "no_op",
        completedAt: null,
        reasonCode: "internal_error",
      },
      {
        status: "open",
        result: "rejected",
        completedAt: null,
        reasonCode: "internal_error",
      },
      // "Finalisation could not conclude" is not a way to CONCLUDE.
      {
        status: "completed",
        result: "incomplete",
        completedAt: new Date(),
        reasonCode: "internal_error",
      },
      // A refusal that claims it applied something, and its mirror image.
      {
        status: "rejected",
        result: "applied",
        completedAt: new Date(),
        reasonCode: "internal_error",
      },
      {
        status: "completed",
        result: "rejected",
        completedAt: new Date(),
        reasonCode: "internal_error",
      },
    ] as const;

    for (const row of illegal) {
      await expect(
        db
          .insert(guestImports)
          .values({ ...base, importKey: randomUUID(), ...row }),
      ).rejects.toThrow();
    }
  });

  it("refuses a concluded import that does not say WHY it concluded (0005)", async () => {
    // `status` says an import was refused; without a reason nobody can act on
    // it — not the client deciding whether a retry could ever succeed, not the
    // learner owed an explanation, not an operator reading the table later.
    const db = getDb();
    const userId = await createTestUser();
    const base = {
      userId,
      deviceId: "device-1",
      snapshotHash: "a".repeat(64),
      completedAt: new Date(),
    };

    for (const row of [
      { status: "completed", result: "applied" },
      { status: "rejected", result: "rejected" },
    ] as const) {
      await expect(
        db.insert(guestImports).values({
          ...base,
          ...row,
          importKey: randomUUID(),
          // reasonCode deliberately omitted
        }),
      ).rejects.toThrow();
    }

    // An OPEN import may be silent — it has not decided anything yet.
    await expect(
      db.insert(guestImports).values({
        userId,
        deviceId: "device-1",
        importKey: randomUUID(),
        snapshotHash: "a".repeat(64),
      }),
    ).resolves.toBeDefined();
  });

  it("bounds the reason to the protocol's own vocabulary (0005)", async () => {
    // The reason is read by the client, so it may never carry free text: not a
    // raw error, not a SQL fragment, not a payload echo (§30). The protocol
    // refuses those at the wire; this is what still holds when a repair query
    // writes without passing through it.
    const db = getDb();
    const userId = await createTestUser();

    await expect(
      db.insert(guestImports).values({
        userId,
        deviceId: "device-1",
        importKey: randomUUID(),
        snapshotHash: "a".repeat(64),
        status: "rejected",
        completedAt: new Date(),
        result: "rejected",
        reasonCode: "duplicate key value violates unique constraint",
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(guestImports).values({
        userId,
        deviceId: "device-1",
        importKey: randomUUID(),
        snapshotHash: "b".repeat(64),
        status: "rejected",
        completedAt: new Date(),
        result: "rejected",
        // The one durable rejection this phase can actually produce.
        reasonCode: "list_ceiling_exceeded",
      }),
    ).resolves.toBeDefined();
  });

  it("rejects a malformed snapshot hash written outside the protocol boundary", async () => {
    // The protocol refuses these at the wire; this is what still holds when a
    // seed script, a backfill or a repair query writes directly.
    const db = getDb();
    const userId = await createTestUser();
    for (const snapshotHash of ["", "abc", "A".repeat(64), "z".repeat(64)]) {
      await expect(
        db.insert(guestImports).values({
          userId,
          deviceId: "device-1",
          importKey: randomUUID(),
          snapshotHash,
        }),
      ).rejects.toThrow();
    }
  });

  it("refuses a summary carrying anything that is not a count", async () => {
    // §30: no raw payloads and no Arabic answers in audit records. Every field
    // of the merge summary is a count, so a non-numeric value here is by
    // definition something that does not belong. The database refuses it rather
    // than trusting whatever code happens to be writing.
    const db = getDb();
    const userId = await createTestUser();
    const row = {
      userId,
      deviceId: "device-1",
      snapshotHash: "a".repeat(64),
      status: "completed" as const,
      completedAt: new Date(),
      result: "applied" as const,
      reasonCode: "already_completed" as const,
    };

    await expect(
      db.insert(guestImports).values({
        ...row,
        importKey: randomUUID(),
        summary: { attemptsApplied: 1, eventsApplied: 2 },
      }),
    ).resolves.toBeDefined();

    for (const summary of [
      // A debugging field someone added "just for now".
      { attemptsApplied: 1, lastRejectedPrompt: "some text" },
      // A nested payload fragment.
      { attemptsApplied: 1, sample: { entryId: 3 } },
      // Not an object at all.
      [1, 2, 3],
      "applied",
    ]) {
      await expect(
        db.insert(guestImports).values({
          ...row,
          importKey: randomUUID(),
          snapshotHash: "b".repeat(64),
          summary,
        }),
      ).rejects.toThrow();
    }
  });

  it("rejects negative counters", async () => {
    const db = getDb();
    const userId = await createTestUser();
    for (const column of [
      "declaredItems",
      "acceptedItems",
      "nextChunkIndex",
      "acceptedLists",
      "eventCount",
      "attemptCount",
    ] as const) {
      await expect(
        db.insert(guestImports).values({
          userId,
          deviceId: "device-1",
          importKey: randomUUID(),
          snapshotHash: "a".repeat(64),
          [column]: -1,
        }),
      ).rejects.toThrow();
    }
  });
});

describe("content_versions constraint integration", () => {
  it("rejects a non-hex64 checksum", async () => {
    const db = getDb();
    await expect(
      db
        .insert(contentVersions)
        .values(contentVersionRow({ checksumLearner: "not-a-checksum" })),
    ).rejects.toThrow();
  });

  it("rejects a non-positive entry_count", async () => {
    const db = getDb();
    await expect(
      db.insert(contentVersions).values(contentVersionRow({ entryCount: 0 })),
    ).rejects.toThrow();
  });

  it("enforces exactly one active release, alongside any number of supported/revoked releases", async () => {
    // `content_versions` has no per-user scoping, so — unlike every other
    // describe block in this file — these assertions must live in ONE test:
    // this file resets once per FILE (tests/integration/setup.ts), so a
    // second test asserting "a second active release is allowed after a
    // supported/revoked one" would collide with the active row this same
    // test already committed.
    const db = getDb();
    await expect(
      db
        .insert(contentVersions)
        .values(contentVersionRow({ releaseStatus: "active" })),
    ).resolves.toBeDefined();
    await expect(
      db
        .insert(contentVersions)
        .values(contentVersionRow({ releaseStatus: "active" })),
    ).rejects.toThrow();
    await expect(
      db
        .insert(contentVersions)
        .values(contentVersionRow({ releaseStatus: "supported" })),
    ).resolves.toBeDefined();
    await expect(
      db
        .insert(contentVersions)
        .values(contentVersionRow({ releaseStatus: "revoked" })),
    ).resolves.toBeDefined();
  });
});
