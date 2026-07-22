import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { studyAttempts } from "@/db/schema";
import { createTestComponent } from "@/tests/integration/helpers/components";
import { createTestRelease } from "@/tests/integration/helpers/content-versions";
import { createTestUser } from "@/tests/integration/helpers/users";

/**
 * `study_attempts` own-column constraint integration suite (distinct from
 * `study-components.test.ts`, which covers `study_components`). Currently
 * just `option_count`'s bounds — the shared generator only ever produces
 * 2-8 options (modules/study-engine/generator.ts's MIN/MAX_OPTION_COUNT),
 * so the database must reject anything outside that range too, not just
 * enforce a floor.
 */
describe("study_attempts constraint integration", () => {
  async function baseAttempt(overrides: { optionCount?: number | null }) {
    const userId = await createTestUser();
    const componentId = await createTestComponent(userId);
    const releaseId = await createTestRelease();
    return {
      id: randomUUID(),
      userId,
      studyComponentId: componentId,
      entryId: 1,
      skillTypeId: "bab_identification",
      promptRef: { entryId: 1, field: "bab" },
      correctAnswerRef: { entryId: 1, field: "bab" },
      isCorrect: true,
      isFirstAttempt: true,
      isReinforcement: false,
      questionPosition: 0,
      mode: "mc" as const,
      optionCount: overrides.optionCount,
      questionInstanceId: randomUUID(),
      questionSeed: "seed",
      questionGeneratorVersion: "1",
      occurredAtUtc: new Date(),
      timezoneAtEvent: "UTC",
      utcOffsetMinutesAtEvent: 0,
      localDateAtEvent: "2026-01-01",
      timezoneSource: "browser_detected" as const,
      deviceId: "device-1",
      releaseId,
      contentVersion: "1.0.0",
    };
  }

  it("rejects an option_count above the generator's maximum of 8", async () => {
    const db = getDb();
    await expect(
      db.insert(studyAttempts).values(await baseAttempt({ optionCount: 9 })),
    ).rejects.toThrow();
  });

  it("rejects an option_count below the generator's minimum of 2", async () => {
    const db = getDb();
    await expect(
      db.insert(studyAttempts).values(await baseAttempt({ optionCount: 1 })),
    ).rejects.toThrow();
  });

  it("accepts every option_count in the valid 2-8 range", async () => {
    const db = getDb();
    for (const optionCount of [2, 3, 4, 5, 6, 7, 8]) {
      await expect(
        db.insert(studyAttempts).values(await baseAttempt({ optionCount })),
      ).resolves.toBeDefined();
    }
  });

  it("accepts a NULL option_count (non-MC modes never set one)", async () => {
    const db = getDb();
    await expect(
      db.insert(studyAttempts).values(await baseAttempt({ optionCount: null })),
    ).resolves.toBeDefined();
  });
});
