import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/db/client";
import { syncAuditLog } from "@/db/schema";
import { writeSyncAudit } from "@/modules/sync/server/audit";
import { createTestUser } from "@/tests/integration/helpers/users";

// The pure redaction policy is unit-tested in
// modules/sync/server/audit-metadata.test.ts (fast tier). These integration
// tests confirm the sink actually PERSISTS the redacted result to Postgres.
describe("writeSyncAudit (persisted redaction)", () => {
  it("persists only allow-listed metadata and never secrets", async () => {
    const userId = await createTestUser();
    const db = getDb();
    await writeSyncAudit(db, {
      userId,
      itemKind: "revocation",
      itemId: "0192f9a0-1111-7abc-8def-0123456789ab",
      reasonCode: "revocation_unknown_event",
      severity: "warning",
      componentKey: "entry:1:skill:meaning_recognition",
      metadata: {
        eventId: "0192f9a0-2222-7abc-8def-0123456789ab",
        status: "scheduling",
        // These MUST be stripped by the sink.
        password: "hunter2",
        sessionToken: "abc.def.ghi",
        selectedAnswerRef: { entryId: 5, field: "meaning" },
      },
    });

    const [row] = await db
      .select()
      .from(syncAuditLog)
      .where(eq(syncAuditLog.userId, userId));
    expect(row?.reasonCode).toBe("revocation_unknown_event");
    expect(row?.severity).toBe("warning");
    expect(row?.metadata).toEqual({
      eventId: "0192f9a0-2222-7abc-8def-0123456789ab",
      status: "scheduling",
    });
    // Belt-and-braces: no secret-looking key survived, in the row's raw JSON.
    const raw = JSON.stringify(row?.metadata);
    expect(raw).not.toContain("password");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("Token");
    expect(raw).not.toContain("selectedAnswerRef");
  });

  it("stores null metadata when nothing safe remains", async () => {
    const userId = await createTestUser();
    const db = getDb();
    await writeSyncAudit(db, {
      userId,
      itemKind: "event",
      itemId: "0192f9a0-3333-7abc-8def-0123456789ab",
      reasonCode: "internal_error",
      severity: "critical",
      metadata: { password: "x", token: "y" }, // all dropped
    });
    const [row] = await db
      .select()
      .from(syncAuditLog)
      .where(eq(syncAuditLog.userId, userId));
    expect(row?.metadata).toBeNull();
  });
});
