import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ContentBuildError,
  prepareReleaseRegistry,
  publishBuiltArtifacts,
} from "@/modules/content/build";
import {
  releaseRegistrySchema,
  type ReleaseRegistry,
} from "@/modules/content/schema";
import { serializeArtifact } from "@/modules/content/stable-json";

const MINIMUMS = {
  minimum_supported_client_version: "0.1.0",
  minimum_supported_event_schema: 1,
};

function registry(partial: Partial<ReleaseRegistry>): ReleaseRegistry {
  return {
    active_release_id: "r1",
    releases: { r1: { status: "active", ...MINIMUMS } },
    ...partial,
  } as ReleaseRegistry;
}

describe("prepareReleaseRegistry (pure)", () => {
  it("first release becomes active with default minimums", () => {
    const next = prepareReleaseRegistry(null, "r1");
    expect(next.active_release_id).toBe("r1");
    expect(next.releases.r1).toEqual({ status: "active", ...MINIMUMS });
  });

  it("activating a second release demotes the first to supported", () => {
    const next = prepareReleaseRegistry(registry({}), "r2");
    expect(next.active_release_id).toBe("r2");
    expect(next.releases.r1.status).toBe("supported");
    expect(next.releases.r2.status).toBe("active");
  });

  it("supported and revoked releases keep their status", () => {
    const current = registry({
      active_release_id: "r3",
      releases: {
        r1: { status: "supported", ...MINIMUMS },
        r2: { status: "revoked", ...MINIMUMS },
        r3: { status: "active", ...MINIMUMS },
      },
    });
    const next = prepareReleaseRegistry(current, "r4");
    expect(next.releases.r1.status).toBe("supported");
    expect(next.releases.r2.status).toBe("revoked");
    expect(next.releases.r3.status).toBe("supported");
    expect(next.releases.r4.status).toBe("active");
  });

  it("a revoked target cannot be activated", () => {
    const current = registry({
      active_release_id: "r2",
      releases: {
        r1: { status: "revoked", ...MINIMUMS },
        r2: { status: "active", ...MINIMUMS },
      },
    });
    expect(() => prepareReleaseRegistry(current, "r1")).toThrow(
      ContentBuildError,
    );
  });

  it("exactly one release is active and matches active_release_id", () => {
    const current = registry({
      active_release_id: "r2",
      releases: {
        r1: { status: "supported", ...MINIMUMS },
        r2: { status: "active", ...MINIMUMS },
      },
    });
    const next = prepareReleaseRegistry(current, "r3");
    const activeIds = Object.entries(next.releases)
      .filter(([, r]) => r.status === "active")
      .map(([id]) => id);
    expect(activeIds).toEqual(["r3"]);
    expect(next.active_release_id).toBe("r3");
  });

  it("protocol minimums survive demotion and reactivation", () => {
    const custom = {
      minimum_supported_client_version: "0.5.0",
      minimum_supported_event_schema: 3,
    };
    const current = registry({
      active_release_id: "r1",
      releases: { r1: { status: "active", ...custom } },
    });
    const demoted = prepareReleaseRegistry(current, "r2");
    expect(demoted.releases.r1).toEqual({ status: "supported", ...custom });
    const reactivated = prepareReleaseRegistry(demoted, "r1");
    expect(reactivated.releases.r1).toEqual({ status: "active", ...custom });
    expect(reactivated.releases.r2.status).toBe("supported");
  });

  it("rejects an invalid registry with multiple active releases", () => {
    const invalid = {
      active_release_id: "r1",
      releases: {
        r1: { status: "active", ...MINIMUMS },
        r2: { status: "active", ...MINIMUMS },
      },
    } as ReleaseRegistry;
    expect(() => prepareReleaseRegistry(invalid, "r3")).toThrow(
      /exactly one release/,
    );
  });

  it("rejects a registry whose active_release_id is missing or not active", () => {
    expect(() =>
      releaseRegistrySchema.parse({
        active_release_id: "ghost",
        releases: { r1: { status: "active", ...MINIMUMS } },
      }),
    ).toThrow(/not present/);
    expect(() =>
      releaseRegistrySchema.parse({
        active_release_id: "r1",
        releases: { r1: { status: "supported", ...MINIMUMS } },
      }),
    ).toThrow();
  });
});

describe("publishBuiltArtifacts (temp dirs)", () => {
  function fixtureBuilt(releaseId: string) {
    return {
      releaseId,
      serialized: {
        learner: `{"release_id": "${releaseId}", "fixture": "learner"}\n`,
        validation: `{"release_id": "${releaseId}", "fixture": "validation"}\n`,
        assessment: `{"release_id": "${releaseId}", "fixture": "assessment"}\n`,
        checksums: `{"release_id": "${releaseId}", "fixture": "checksums"}\n`,
        activePointer: `{"release_id": "${releaseId}", "fixture": "pointer"}\n`,
      },
    };
  }

  function tempDirs() {
    const root = mkdtempSync(join(tmpdir(), "safwa-publish-"));
    return {
      root,
      publicContentDir: join(root, "public", "content"),
      serverContentDir: join(root, "content-server"),
    };
  }

  it("publishes in order and activating a second release leaves one active", () => {
    const { root, publicContentDir, serverContentDir } = tempDirs();
    try {
      publishBuiltArtifacts({
        built: fixtureBuilt("rel-a"),
        publicContentDir,
        serverContentDir,
      });
      const afterFirst = releaseRegistrySchema.parse(
        JSON.parse(
          readFileSync(join(serverContentDir, "release-registry.json"), "utf8"),
        ),
      );
      expect(afterFirst.active_release_id).toBe("rel-a");

      publishBuiltArtifacts({
        built: fixtureBuilt("rel-b"),
        publicContentDir,
        serverContentDir,
      });
      const afterSecond = releaseRegistrySchema.parse(
        JSON.parse(
          readFileSync(join(serverContentDir, "release-registry.json"), "utf8"),
        ),
      );
      expect(afterSecond.active_release_id).toBe("rel-b");
      expect(afterSecond.releases["rel-a"].status).toBe("supported");
      expect(afterSecond.releases["rel-b"].status).toBe("active");
      // Pointer now belongs to rel-b; both immutable dirs still exist.
      expect(
        readFileSync(join(publicContentDir, "active.json"), "utf8"),
      ).toContain("rel-b");
      expect(
        readFileSync(
          join(publicContentDir, "releases", "rel-a", "learner.json"),
          "utf8",
        ),
      ).toContain("rel-a");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a revoked target changes neither pointer nor registry nor immutables", () => {
    const { root, publicContentDir, serverContentDir } = tempDirs();
    try {
      publishBuiltArtifacts({
        built: fixtureBuilt("rel-a"),
        publicContentDir,
        serverContentDir,
      });
      // Operationally revoke rel-b (pre-registered) then try to publish it.
      const registryPath = join(serverContentDir, "release-registry.json");
      const current = releaseRegistrySchema.parse(
        JSON.parse(readFileSync(registryPath, "utf8")),
      );
      const withRevoked = {
        ...current,
        releases: {
          ...current.releases,
          "rel-b": { status: "revoked" as const, ...MINIMUMS },
        },
      };
      writeFileSync(registryPath, serializeArtifact(withRevoked), "utf8");

      const pointerBefore = readFileSync(
        join(publicContentDir, "active.json"),
        "utf8",
      );
      const registryBefore = readFileSync(registryPath, "utf8");

      expect(() =>
        publishBuiltArtifacts({
          built: fixtureBuilt("rel-b"),
          publicContentDir,
          serverContentDir,
        }),
      ).toThrow(/revoked/);

      // Nothing mutable changed; no immutable rel-b files were created.
      expect(readFileSync(join(publicContentDir, "active.json"), "utf8")).toBe(
        pointerBefore,
      );
      expect(readFileSync(registryPath, "utf8")).toBe(registryBefore);
      expect(() =>
        readFileSync(
          join(publicContentDir, "releases", "rel-b", "learner.json"),
          "utf8",
        ),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("republishing the same release is an idempotent no-op", () => {
    const { root, publicContentDir, serverContentDir } = tempDirs();
    try {
      publishBuiltArtifacts({
        built: fixtureBuilt("rel-a"),
        publicContentDir,
        serverContentDir,
      });
      const before = readFileSync(
        join(serverContentDir, "release-registry.json"),
        "utf8",
      );
      publishBuiltArtifacts({
        built: fixtureBuilt("rel-a"),
        publicContentDir,
        serverContentDir,
      });
      expect(
        readFileSync(join(serverContentDir, "release-registry.json"), "utf8"),
      ).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("differing immutable bytes fail before the registry or pointer change", () => {
    const { root, publicContentDir, serverContentDir } = tempDirs();
    try {
      publishBuiltArtifacts({
        built: fixtureBuilt("rel-a"),
        publicContentDir,
        serverContentDir,
      });
      const registryPath = join(serverContentDir, "release-registry.json");
      const pointerPath = join(publicContentDir, "active.json");
      const registryBefore = readFileSync(registryPath, "utf8");
      const pointerBefore = readFileSync(pointerPath, "utf8");

      const tampered = fixtureBuilt("rel-a");
      tampered.serialized.learner = '{"different": "bytes"}\n';
      expect(() =>
        publishBuiltArtifacts({
          built: tampered,
          publicContentDir,
          serverContentDir,
        }),
      ).toThrow(/different bytes/);
      expect(readFileSync(registryPath, "utf8")).toBe(registryBefore);
      expect(readFileSync(pointerPath, "utf8")).toBe(pointerBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
