import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { sha256HexUtf8 } from "@/modules/content/checksum";
import {
  loadAndVerifyRelease,
  ManifestVerificationError,
} from "@/modules/content/server-manifests";
import {
  getActiveRelease,
  resetServerManifestCacheForTests,
  setVerifiedReleaseForTests,
} from "@/modules/content/server-release-registry";
import {
  buildManifestFixture,
  writeRegistry,
  type ManifestFixture,
} from "@/tests/content/helpers/manifest-fixture";

let fixture: ManifestFixture;

beforeEach(async () => {
  fixture = await buildManifestFixture();
  resetServerManifestCacheForTests();
});

afterEach(async () => {
  await fixture.cleanup();
  resetServerManifestCacheForTests();
});

function loadOptions() {
  return {
    contentServerDir: fixture.contentServerDir,
    publicContentDir: fixture.publicContentDir,
  };
}

function artifactPath(
  artifact: "learner" | "validation" | "assessment" | "checksums",
): string {
  const dir =
    artifact === "learner"
      ? fixture.publicContentDir
      : fixture.contentServerDir;
  return join(dir, "releases", fixture.releaseId, `${artifact}.json`);
}

/**
 * Rewrites one field on `artifact`, recomputes checksums.json against the
 * rewritten bytes, and writes both back — isolating a cross-artifact
 * IDENTITY mismatch from a checksum mismatch (which would fail earlier).
 */
async function corruptIdentityField(
  artifact: "learner" | "validation" | "assessment",
  field: string,
  value: string | number,
): Promise<void> {
  const raw = await readFile(artifactPath(artifact), "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  parsed[field] = value;
  const rewritten = JSON.stringify(parsed, null, 2);
  await fixture.corrupt(artifact, rewritten);

  const checksumsRaw = await readFile(artifactPath("checksums"), "utf8");
  const checksums = JSON.parse(checksumsRaw) as Record<string, string>;
  checksums[artifact] = sha256HexUtf8(rewritten);
  await fixture.corrupt("checksums", checksums);
}

describe("loadAndVerifyRelease", () => {
  it("loads a valid active release", async () => {
    const release = await loadAndVerifyRelease(
      fixture.releaseId,
      loadOptions(),
    );
    expect(release.releaseId).toBe(fixture.releaseId);
    expect(release.entryCount).toBe(1);
    expect(release.learner.entries).toHaveLength(1);
  });

  it("rejects a learner checksum mismatch", async () => {
    const original = await readFile(artifactPath("learner"), "utf8");
    await fixture.corrupt("learner", original.replace('"m1"', '"tampered"'));
    await expect(
      loadAndVerifyRelease(fixture.releaseId, loadOptions()),
    ).rejects.toThrow(ManifestVerificationError);
  });

  it("rejects a validation checksum mismatch", async () => {
    const original = await readFile(artifactPath("validation"), "utf8");
    await fixture.corrupt(
      "validation",
      original.replace('"nasara"', '"daraba"'),
    );
    await expect(
      loadAndVerifyRelease(fixture.releaseId, loadOptions()),
    ).rejects.toThrow(ManifestVerificationError);
  });

  it("rejects an assessment checksum mismatch", async () => {
    const original = await readFile(artifactPath("assessment"), "utf8");
    await fixture.corrupt("assessment", original.replace('"m1"', '"tampered"'));
    await expect(
      loadAndVerifyRelease(fixture.releaseId, loadOptions()),
    ).rejects.toThrow(ManifestVerificationError);
  });

  it("rejects when checksums.json itself is malformed", async () => {
    await fixture.corrupt("checksums", { not: "a checksum manifest" });
    await expect(
      loadAndVerifyRelease(fixture.releaseId, loadOptions()),
    ).rejects.toThrow(ManifestVerificationError);
  });

  it("rejects a release_id mismatch between checksums.json and the requested id", async () => {
    const raw = await readFile(artifactPath("checksums"), "utf8");
    const parsed = JSON.parse(raw) as { release_id: string };
    parsed.release_id = "a-different-release";
    await fixture.corrupt("checksums", parsed);
    await expect(
      loadAndVerifyRelease(fixture.releaseId, loadOptions()),
    ).rejects.toThrow(ManifestVerificationError);
  });

  // Each row rewrites one identity field on one artifact (recomputing
  // checksums.json against the rewritten bytes so only the cross-artifact
  // IDENTITY check — not the checksum check — can reject it).
  it.each([
    ["content_version", "validation", "9.9.9"],
    ["schema_version", "assessment", "9.9.9"],
    ["question_generator_version", "validation", "999"],
    ["entry_count", "assessment", 999],
  ] as const)(
    "rejects a %s mismatch between artifacts",
    async (field, artifact, value) => {
      await corruptIdentityField(artifact, field, value);
      await expect(
        loadAndVerifyRelease(fixture.releaseId, loadOptions()),
      ).rejects.toThrow(/identity mismatch/);
    },
  );

  it("rejects unknown fields in any artifact (strict schemas)", async () => {
    const raw = await readFile(artifactPath("learner"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed.unexpected_field = "should not be here";
    const rewritten = JSON.stringify(parsed, null, 2);
    await fixture.corrupt("learner", rewritten);
    const checksumsRaw = await readFile(artifactPath("checksums"), "utf8");
    const checksums = JSON.parse(checksumsRaw) as Record<string, string>;
    checksums.learner = sha256HexUtf8(rewritten);
    await fixture.corrupt("checksums", checksums);

    await expect(
      loadAndVerifyRelease(fixture.releaseId, loadOptions()),
    ).rejects.toThrow(ManifestVerificationError);
  });

  it("rejects a missing file", async () => {
    await rm(artifactPath("assessment"));
    await expect(
      loadAndVerifyRelease(fixture.releaseId, loadOptions()),
    ).rejects.toThrow(ManifestVerificationError);
  });

  it("rejects invalid JSON", async () => {
    await fixture.corrupt("checksums", "{ not valid json");
    await expect(
      loadAndVerifyRelease(fixture.releaseId, loadOptions()),
    ).rejects.toThrow(ManifestVerificationError);
  });

  it("rejects path traversal in the release id", async () => {
    await expect(
      loadAndVerifyRelease("../../etc/passwd", loadOptions()),
    ).rejects.toThrow(ManifestVerificationError);
    await expect(loadAndVerifyRelease("..", loadOptions())).rejects.toThrow(
      ManifestVerificationError,
    );
  });

  it("rejects a malformed release id", async () => {
    await expect(
      loadAndVerifyRelease("/absolute/path", loadOptions()),
    ).rejects.toThrow(ManifestVerificationError);
    await expect(loadAndVerifyRelease("", loadOptions())).rejects.toThrow(
      ManifestVerificationError,
    );
  });

  it("rejects a contentServerDir/publicContentDir override outside NODE_ENV=test", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      await expect(
        loadAndVerifyRelease(fixture.releaseId, loadOptions()),
      ).rejects.toThrow(/only permitted when NODE_ENV=test/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("never leaks an absolute filesystem path in a thrown error message", async () => {
    await rm(artifactPath("assessment"));
    await expect(
      loadAndVerifyRelease(fixture.releaseId, loadOptions()),
    ).rejects.toThrow(
      `Missing or unreadable assessment.json for release ${fixture.releaseId}`,
    );
  });

  it("concurrent loads for the same release id via getActiveRelease coalesce onto one verification", async () => {
    await writeRegistry(fixture.contentServerDir, {
      active_release_id: fixture.releaseId,
      releases: {
        [fixture.releaseId]: {
          status: "active",
          minimum_supported_client_version: "0.1.0",
          minimum_supported_event_schema: 1,
        },
      },
    });
    const options = { registryDir: fixture.contentServerDir, ...loadOptions() };
    const [first, second, third] = await Promise.all([
      getActiveRelease(options),
      getActiveRelease(options),
      getActiveRelease(options),
    ]);
    // Coalesced onto the same in-flight promise: identical object reference.
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it("a failed load can succeed after the underlying fixture is corrected", async () => {
    const original = await readFile(artifactPath("assessment"), "utf8");
    await fixture.corrupt("assessment", "not valid json at all");
    await expect(
      loadAndVerifyRelease(fixture.releaseId, loadOptions()),
    ).rejects.toThrow(ManifestVerificationError);

    // Restore the original, valid bytes — a fresh call must succeed (the
    // prior failure must never have been cached as if it were a success).
    await fixture.corrupt("assessment", original);
    await expect(
      loadAndVerifyRelease(fixture.releaseId, loadOptions()),
    ).resolves.toBeDefined();
  });
});

describe("getActiveRelease / registry resolution", () => {
  it("resolves the active release from a valid registry", async () => {
    await writeRegistry(fixture.contentServerDir, {
      active_release_id: fixture.releaseId,
      releases: {
        [fixture.releaseId]: {
          status: "active",
          minimum_supported_client_version: "0.1.0",
          minimum_supported_event_schema: 1,
        },
      },
    });
    const release = await getActiveRelease({
      registryDir: fixture.contentServerDir,
      ...loadOptions(),
    });
    expect(release.releaseId).toBe(fixture.releaseId);
  });

  it("rejects when the registry references a missing release", async () => {
    await writeRegistry(fixture.contentServerDir, {
      active_release_id: "does-not-exist",
      releases: {
        [fixture.releaseId]: {
          status: "supported",
          minimum_supported_client_version: "0.1.0",
          minimum_supported_event_schema: 1,
        },
      },
    });
    await expect(
      getActiveRelease({
        registryDir: fixture.contentServerDir,
        ...loadOptions(),
      }),
    ).rejects.toThrow(ManifestVerificationError);
  });

  it("rejects a registry with more than one active release", async () => {
    await writeRegistry(fixture.contentServerDir, {
      active_release_id: fixture.releaseId,
      releases: {
        [fixture.releaseId]: {
          status: "active",
          minimum_supported_client_version: "0.1.0",
          minimum_supported_event_schema: 1,
        },
        "another-release": {
          status: "active",
          minimum_supported_client_version: "0.1.0",
          minimum_supported_event_schema: 1,
        },
      },
    });
    await expect(
      getActiveRelease({
        registryDir: fixture.contentServerDir,
        ...loadOptions(),
      }),
    ).rejects.toThrow(ManifestVerificationError);
  });

  it("rejects when active_release_id points to a supported (not active) release", async () => {
    await writeRegistry(fixture.contentServerDir, {
      active_release_id: fixture.releaseId,
      releases: {
        [fixture.releaseId]: {
          status: "supported",
          minimum_supported_client_version: "0.1.0",
          minimum_supported_event_schema: 1,
        },
      },
    });
    await expect(
      getActiveRelease({
        registryDir: fixture.contentServerDir,
        ...loadOptions(),
      }),
    ).rejects.toThrow(ManifestVerificationError);
  });

  it("rejects a revoked active release", async () => {
    // Bypass the registry schema's own superRefine (which already forbids
    // active_release_id pointing at a non-"active" row) by writing raw JSON
    // directly, to prove getActiveRelease's OWN status check is also
    // load-bearing, not merely relying on the Zod schema every time.
    await writeFile(
      join(fixture.contentServerDir, "release-registry.json"),
      JSON.stringify({
        active_release_id: fixture.releaseId,
        releases: {
          [fixture.releaseId]: {
            status: "revoked",
            minimum_supported_client_version: "0.1.0",
            minimum_supported_event_schema: 1,
          },
        },
      }),
      "utf8",
    );
    // This registry is invalid per the schema too (active_release_id must
    // point at an active row) — confirms fail-closed either way.
    await expect(
      getActiveRelease({
        registryDir: fixture.contentServerDir,
        ...loadOptions(),
      }),
    ).rejects.toThrow(ManifestVerificationError);
  });

  it("test helper: can inject a pre-verified release directly, bypassing disk I/O", async () => {
    const release = await loadAndVerifyRelease(
      fixture.releaseId,
      loadOptions(),
    );
    resetServerManifestCacheForTests();
    setVerifiedReleaseForTests(fixture.releaseId, release);
    await writeRegistry(fixture.contentServerDir, {
      active_release_id: fixture.releaseId,
      releases: {
        [fixture.releaseId]: {
          status: "active",
          minimum_supported_client_version: "0.1.0",
          minimum_supported_event_schema: 1,
        },
      },
    });
    const resolved = await getActiveRelease({
      registryDir: fixture.contentServerDir,
      ...loadOptions(),
    });
    expect(resolved).toBe(release);
  });

  it("rejects a registryDir override outside NODE_ENV=test", async () => {
    await writeRegistry(fixture.contentServerDir, {
      active_release_id: fixture.releaseId,
      releases: {
        [fixture.releaseId]: {
          status: "active",
          minimum_supported_client_version: "0.1.0",
          minimum_supported_event_schema: 1,
        },
      },
    });
    vi.stubEnv("NODE_ENV", "production");
    try {
      await expect(
        getActiveRelease({
          registryDir: fixture.contentServerDir,
          ...loadOptions(),
        }),
      ).rejects.toThrow(/only permitted when NODE_ENV=test/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("client-side import boundary", () => {
  it("server-manifests.ts is never imported by the browser-safe content barrel", async () => {
    const barrel = await import("@/modules/content/index");
    expect(Object.keys(barrel)).not.toContain("loadAndVerifyRelease");
    expect(Object.keys(barrel)).not.toContain("getActiveRelease");
  });
});
