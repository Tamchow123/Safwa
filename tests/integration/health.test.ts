import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";
import { readRegistry } from "@/modules/content/server-release-registry";

/**
 * End-to-end health-check proof against the real disposable Postgres DB
 * and the real content-server manifests fixture (tests/api/health.test.ts
 * covers the mocked healthy/unhealthy/timeout response-shape variations).
 */
describe("/api/health (real database + content manifests)", () => {
  it("reports healthy with the real active release id when the DB and manifests are both reachable", async () => {
    const registry = await readRegistry();

    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.database).toBe("ok");
    expect(body.activeReleaseId).toBe(registry.active_release_id);
    expect(typeof body.authEnabled).toBe("boolean");
  });
});
