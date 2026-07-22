import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Scoped mock: release.ts is server-only; the pure default export condition
// would otherwise throw on import (see tests/env/server.test.ts for rationale).
vi.mock("server-only", () => ({}));

import {
  readRegistry,
  resetServerManifestCacheForTests,
} from "@/modules/content/server-release-registry";

import { resolveReleaseForIngestion } from "./release";

// Explicit test-dir overrides so getServerEnv() (which needs the full server
// env) is never required in this unit test — permitted under NODE_ENV=test.
const REAL_DIRS = {
  registryDir: "content-server",
  contentServerDir: "content-server",
  publicContentDir: "public/content",
} as const;

const SUPPORT = {
  minimum_supported_client_version: "0.1.0",
  minimum_supported_event_schema: 1,
} as const;

let activeReleaseId: string;
let revokedRegistryDir: string;
let supportedRegistryDir: string;
let missingManifestRegistryDir: string;

async function writeFixtureRegistry(
  releases: Record<string, unknown>,
  activeId: string,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "safwa-sync-registry-"));
  await writeFile(
    path.join(dir, "release-registry.json"),
    JSON.stringify({ active_release_id: activeId, releases }),
    "utf8",
  );
  return dir;
}

beforeAll(async () => {
  // The real active release id, read from the committed registry.
  const registry = await readRegistry(REAL_DIRS.registryDir);
  activeReleaseId = registry.active_release_id;

  // Fixture registries (no manifest files needed for the reject-before-load
  // cases; the "supported" case reuses the REAL release's intact manifests).
  revokedRegistryDir = await writeFixtureRegistry(
    {
      "safwa-fixture-active": { status: "active", ...SUPPORT },
      "safwa-fixture-revoked": { status: "revoked", ...SUPPORT },
    },
    "safwa-fixture-active",
  );
  supportedRegistryDir = await writeFixtureRegistry(
    {
      "safwa-fixture-active": { status: "active", ...SUPPORT },
      [activeReleaseId]: { status: "supported", ...SUPPORT },
    },
    "safwa-fixture-active",
  );
  missingManifestRegistryDir = await writeFixtureRegistry(
    {
      "safwa-fixture-active": { status: "active", ...SUPPORT },
      "safwa-missing-manifests": { status: "supported", ...SUPPORT },
    },
    "safwa-fixture-active",
  );
});

afterEach(() => {
  resetServerManifestCacheForTests();
  vi.restoreAllMocks();
});

describe("resolveReleaseForIngestion", () => {
  it("resolves the real active release with its full verified manifests", async () => {
    const result = await resolveReleaseForIngestion(activeReleaseId, REAL_DIRS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("active");
      expect(result.release.releaseId).toBe(activeReleaseId);
      expect(result.release.entryCount).toBe(455);
    }
  });

  it("rejects an unknown release id as invalid_release", async () => {
    const result = await resolveReleaseForIngestion(
      "safwa-does-not-exist",
      REAL_DIRS,
    );
    expect(result).toEqual({ ok: false, reasonCode: "invalid_release" });
  });

  it("rejects a revoked release recoverably (before loading manifests)", async () => {
    const result = await resolveReleaseForIngestion("safwa-fixture-revoked", {
      registryDir: revokedRegistryDir,
    });
    expect(result).toEqual({ ok: false, reasonCode: "revoked_release" });
  });

  it("resolves a supported (non-active) release via the supported path", async () => {
    const result = await resolveReleaseForIngestion(activeReleaseId, {
      registryDir: supportedRegistryDir,
      contentServerDir: REAL_DIRS.contentServerDir,
      publicContentDir: REAL_DIRS.publicContentDir,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("supported");
      expect(result.release.entryCount).toBe(455);
    }
  });

  it("rejects an unreadable registry as invalid_release and logs it server-side", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await resolveReleaseForIngestion("safwa-anything", {
      registryDir: path.join(tmpdir(), "safwa-nonexistent-registry-dir-xyz"),
    });
    expect(result).toEqual({ ok: false, reasonCode: "invalid_release" });
    expect(errorSpy).toHaveBeenCalled();
  });

  it("rejects a supported release whose manifests are missing and logs it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await resolveReleaseForIngestion("safwa-missing-manifests", {
      registryDir: missingManifestRegistryDir,
      contentServerDir: REAL_DIRS.contentServerDir,
      publicContentDir: REAL_DIRS.publicContentDir,
    });
    expect(result).toEqual({ ok: false, reasonCode: "invalid_release" });
    expect(errorSpy).toHaveBeenCalled();
  });
});
