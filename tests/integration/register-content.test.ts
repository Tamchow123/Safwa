import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import {
  ContentRegistrationError,
  registerContent,
} from "@/db/register-content";
import { contentVersions } from "@/db/schema";
import {
  addReleaseToFixture,
  buildManifestFixture,
  writeRegistry,
  type ManifestFixture,
} from "@/tests/content/helpers/manifest-fixture";

// `content_versions` has no user_id column, so — like every other test file
// touching it (see tests/integration/setup.ts) — this file resets once per
// FILE, not per test, and every registry a test writes still must satisfy
// the release-registry schema's "exactly one active release" invariant.
// To avoid two unrelated tests each registering a DIFFERENT release as
// 'active' (which would collide on content_versions' single-active partial
// unique index, since nothing demotes an earlier test's row), every test
// after the first reuses "release-b" — always built with the exact same
// default fixture content, so its checksums never change across tests — as
// a shared, byte-identical "active anchor" release. Only the very first
// test (which proves the active/supported swap itself) ever changes which
// release is active.
const ACTIVE_ANCHOR_ID = "release-b";

function activeAnchorEntry() {
  return {
    status: "active" as const,
    minimum_supported_client_version: "0.1.0",
    minimum_supported_event_schema: 1,
  };
}

let fixture: ManifestFixture | undefined;
let secondFixture: ManifestFixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  await secondFixture?.cleanup();
  fixture = undefined;
  secondFixture = undefined;
});

function optionsFor(f: ManifestFixture) {
  return {
    registryDir: f.contentServerDir,
    contentServerDir: f.contentServerDir,
    publicContentDir: f.publicContentDir,
  };
}

async function findRelease(releaseId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(contentVersions)
    .where(eq(contentVersions.releaseId, releaseId));
  return row;
}

describe("registerContent", () => {
  it("marks exactly the registry's active release as active, and safely swaps which release is active on a repeat run", async () => {
    fixture = await buildManifestFixture({ releaseId: "release-a" });
    await addReleaseToFixture(fixture, { releaseId: ACTIVE_ANCHOR_ID });

    await writeRegistry(fixture.contentServerDir, {
      active_release_id: "release-a",
      releases: {
        "release-a": {
          status: "active",
          minimum_supported_client_version: "0.1.0",
          minimum_supported_event_schema: 1,
        },
        [ACTIVE_ANCHOR_ID]: {
          status: "supported",
          minimum_supported_client_version: "0.1.0",
          minimum_supported_event_schema: 1,
        },
      },
    });
    await registerContent(getDb(), optionsFor(fixture));

    const db = getDb();
    let activeRows = await db
      .select()
      .from(contentVersions)
      .where(eq(contentVersions.releaseStatus, "active"));
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].releaseId).toBe("release-a");

    // Swap: the shared anchor becomes active, release-a becomes supported.
    // Neither release's artifacts/checksums change — only the registry's
    // mutable status flips. From here on, every other test in this file
    // relies on ACTIVE_ANCHOR_ID staying the sole active release.
    await writeRegistry(fixture.contentServerDir, {
      active_release_id: ACTIVE_ANCHOR_ID,
      releases: {
        "release-a": {
          status: "supported",
          minimum_supported_client_version: "0.1.0",
          minimum_supported_event_schema: 1,
        },
        [ACTIVE_ANCHOR_ID]: activeAnchorEntry(),
      },
    });
    await expect(
      registerContent(getDb(), optionsFor(fixture)),
    ).resolves.toEqual({ registered: ["release-a", ACTIVE_ANCHOR_ID] });

    activeRows = await db
      .select()
      .from(contentVersions)
      .where(eq(contentVersions.releaseStatus, "active"));
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].releaseId).toBe(ACTIVE_ANCHOR_ID);

    const releaseA = await findRelease("release-a");
    expect(releaseA.releaseStatus).toBe("supported");
  });

  it("registers a new release into content_versions with fields matching the registry", async () => {
    fixture = await buildManifestFixture({
      releaseId: "release-fields-check",
      contentVersion: "1.2.3",
      questionGeneratorVersion: "7",
      entryCount: 42,
    });
    await addReleaseToFixture(fixture, { releaseId: ACTIVE_ANCHOR_ID });
    await writeRegistry(fixture.contentServerDir, {
      active_release_id: ACTIVE_ANCHOR_ID,
      releases: {
        "release-fields-check": {
          status: "supported",
          minimum_supported_client_version: "0.2.0",
          minimum_supported_event_schema: 3,
        },
        [ACTIVE_ANCHOR_ID]: activeAnchorEntry(),
      },
    });

    const result = await registerContent(getDb(), optionsFor(fixture));
    expect(result.registered).toContain("release-fields-check");

    const row = await findRelease("release-fields-check");
    expect(row).toBeDefined();
    expect(row.contentVersion).toBe("1.2.3");
    expect(row.questionGeneratorVersion).toBe("7");
    expect(row.entryCount).toBe(42);
    expect(row.releaseStatus).toBe("supported");
    expect(row.minimumSupportedClientVersion).toBe("0.2.0");
    expect(row.minimumSupportedEventSchema).toBe(3);
    expect(row.checksumLearner).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is idempotent: registering the same unchanged release twice does not error or duplicate the row", async () => {
    fixture = await buildManifestFixture({ releaseId: "release-idempotent" });
    await addReleaseToFixture(fixture, { releaseId: ACTIVE_ANCHOR_ID });
    await writeRegistry(fixture.contentServerDir, {
      active_release_id: ACTIVE_ANCHOR_ID,
      releases: {
        "release-idempotent": {
          status: "supported",
          minimum_supported_client_version: "0.1.0",
          minimum_supported_event_schema: 1,
        },
        [ACTIVE_ANCHOR_ID]: activeAnchorEntry(),
      },
    });

    await registerContent(getDb(), optionsFor(fixture));
    await expect(
      registerContent(getDb(), optionsFor(fixture)),
    ).resolves.toEqual({
      registered: ["release-idempotent", ACTIVE_ANCHOR_ID],
    });

    const db = getDb();
    const rows = await db
      .select()
      .from(contentVersions)
      .where(eq(contentVersions.releaseId, "release-idempotent"));
    expect(rows).toHaveLength(1);
  });

  it("updates only the mutable registry fields on a repeat run, preserving immutable metadata", async () => {
    fixture = await buildManifestFixture({
      releaseId: "release-mutable-fields",
    });
    await addReleaseToFixture(fixture, { releaseId: ACTIVE_ANCHOR_ID });

    await writeRegistry(fixture.contentServerDir, {
      active_release_id: ACTIVE_ANCHOR_ID,
      releases: {
        "release-mutable-fields": {
          status: "supported",
          minimum_supported_client_version: "0.1.0",
          minimum_supported_event_schema: 1,
        },
        [ACTIVE_ANCHOR_ID]: activeAnchorEntry(),
      },
    });
    await registerContent(getDb(), optionsFor(fixture));

    const original = await findRelease("release-mutable-fields");

    await writeRegistry(fixture.contentServerDir, {
      active_release_id: ACTIVE_ANCHOR_ID,
      releases: {
        "release-mutable-fields": {
          status: "revoked",
          minimum_supported_client_version: "0.5.0",
          minimum_supported_event_schema: 9,
        },
        [ACTIVE_ANCHOR_ID]: activeAnchorEntry(),
      },
    });
    await registerContent(getDb(), optionsFor(fixture));

    const updated = await findRelease("release-mutable-fields");
    expect(updated.releaseStatus).toBe("revoked");
    expect(updated.minimumSupportedClientVersion).toBe("0.5.0");
    expect(updated.minimumSupportedEventSchema).toBe(9);
    // Immutable fields never changed even though the registry re-ran.
    expect(updated.contentVersion).toBe(original.contentVersion);
    expect(updated.checksumLearner).toBe(original.checksumLearner);
  });

  it("rejects re-registering the same release id with different verified content, leaving the original row untouched", async () => {
    fixture = await buildManifestFixture({
      releaseId: "release-conflict",
      entryCount: 10,
    });
    await addReleaseToFixture(fixture, { releaseId: ACTIVE_ANCHOR_ID });
    await writeRegistry(fixture.contentServerDir, {
      active_release_id: ACTIVE_ANCHOR_ID,
      releases: {
        "release-conflict": {
          status: "supported",
          minimum_supported_client_version: "0.1.0",
          minimum_supported_event_schema: 1,
        },
        [ACTIVE_ANCHOR_ID]: activeAnchorEntry(),
      },
    });
    await registerContent(getDb(), optionsFor(fixture));
    const original = await findRelease("release-conflict");

    // A second, independent fixture verifies fully on its own (internally
    // consistent checksums) but reuses the SAME release id with different
    // content — simulating a release id being reused for different bytes.
    secondFixture = await buildManifestFixture({
      releaseId: "release-conflict",
      entryCount: 999,
    });
    await addReleaseToFixture(secondFixture, { releaseId: ACTIVE_ANCHOR_ID });
    await writeRegistry(secondFixture.contentServerDir, {
      active_release_id: ACTIVE_ANCHOR_ID,
      releases: {
        "release-conflict": {
          status: "supported",
          minimum_supported_client_version: "0.1.0",
          minimum_supported_event_schema: 1,
        },
        [ACTIVE_ANCHOR_ID]: activeAnchorEntry(),
      },
    });

    await expect(
      registerContent(getDb(), optionsFor(secondFixture)),
    ).rejects.toThrow(ContentRegistrationError);

    const after = await findRelease("release-conflict");
    expect(after.entryCount).toBe(original.entryCount);
    expect(after.checksumLearner).toBe(original.checksumLearner);
  });

  it("serializes two concurrent registrations of the same not-yet-registered release id without racing", async () => {
    fixture = await buildManifestFixture({
      releaseId: "release-concurrent-same",
    });
    await addReleaseToFixture(fixture, { releaseId: ACTIVE_ANCHOR_ID });
    await writeRegistry(fixture.contentServerDir, {
      active_release_id: ACTIVE_ANCHOR_ID,
      releases: {
        "release-concurrent-same": {
          status: "supported",
          minimum_supported_client_version: "0.1.0",
          minimum_supported_event_schema: 1,
        },
        [ACTIVE_ANCHOR_ID]: activeAnchorEntry(),
      },
    });

    // Both calls read the SAME fixture roots, so they verify identical
    // bytes for "release-concurrent-same" — the transaction-scoped
    // advisory lock (db/register-content.ts) must serialize them so
    // neither observes a torn/duplicate state, regardless of which one
    // wins the race to insert first.
    const [a, b] = await Promise.allSettled([
      registerContent(getDb(), optionsFor(fixture)),
      registerContent(getDb(), optionsFor(fixture)),
    ]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");

    const rows = await getDb()
      .select()
      .from(contentVersions)
      .where(eq(contentVersions.releaseId, "release-concurrent-same"));
    expect(rows).toHaveLength(1);
  });

  it("when two concurrent registrations of the same not-yet-registered release id carry different content, the loser fails with ContentRegistrationError, not a raw driver error", async () => {
    fixture = await buildManifestFixture({
      releaseId: "release-concurrent-conflict",
      entryCount: 1,
    });
    await addReleaseToFixture(fixture, { releaseId: ACTIVE_ANCHOR_ID });
    await writeRegistry(fixture.contentServerDir, {
      active_release_id: ACTIVE_ANCHOR_ID,
      releases: {
        "release-concurrent-conflict": {
          status: "supported",
          minimum_supported_client_version: "0.1.0",
          minimum_supported_event_schema: 1,
        },
        [ACTIVE_ANCHOR_ID]: activeAnchorEntry(),
      },
    });

    secondFixture = await buildManifestFixture({
      releaseId: "release-concurrent-conflict",
      entryCount: 2,
    });
    await addReleaseToFixture(secondFixture, { releaseId: ACTIVE_ANCHOR_ID });
    await writeRegistry(secondFixture.contentServerDir, {
      active_release_id: ACTIVE_ANCHOR_ID,
      releases: {
        "release-concurrent-conflict": {
          status: "supported",
          minimum_supported_client_version: "0.1.0",
          minimum_supported_event_schema: 1,
        },
        [ACTIVE_ANCHOR_ID]: activeAnchorEntry(),
      },
    });

    const [a, b] = await Promise.allSettled([
      registerContent(getDb(), optionsFor(fixture)),
      registerContent(getDb(), optionsFor(secondFixture)),
    ]);

    const fulfilled = [a, b].filter((o) => o.status === "fulfilled");
    const rejected = [a, b].filter(
      (o): o is PromiseRejectedResult => o.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ContentRegistrationError);

    const rows = await getDb()
      .select()
      .from(contentVersions)
      .where(eq(contentVersions.releaseId, "release-concurrent-conflict"));
    expect(rows).toHaveLength(1);
  });

  it("never creates vocabulary rows", async () => {
    // content_versions is the only table registerContent writes to; there
    // is no vocabulary table in Postgres at any phase before 21
    // (ARCHITECTURE.md §3) for this to accidentally populate — this test
    // documents that invariant rather than querying a nonexistent table.
    fixture = await buildManifestFixture({ releaseId: "release-no-vocab" });
    await addReleaseToFixture(fixture, { releaseId: ACTIVE_ANCHOR_ID });
    await writeRegistry(fixture.contentServerDir, {
      active_release_id: ACTIVE_ANCHOR_ID,
      releases: {
        "release-no-vocab": {
          status: "supported",
          minimum_supported_client_version: "0.1.0",
          minimum_supported_event_schema: 1,
        },
        [ACTIVE_ANCHOR_ID]: activeAnchorEntry(),
      },
    });
    await expect(
      registerContent(getDb(), optionsFor(fixture)),
    ).resolves.toBeDefined();
  });
});
