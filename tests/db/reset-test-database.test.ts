import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertSafeToReset,
  UnsafeTestDatabaseError,
} from "@/db/reset-test-database";

const HOST = "postgres://safwa:pw@localhost:5432";

describe("assertSafeToReset", () => {
  it("permits safwa_test under NODE_ENV=test", () => {
    expect(assertSafeToReset(`${HOST}/safwa_test`, "test")).toBe("safwa_test");
  });

  it("permits a worker-suffixed safwa_test_<worker> under NODE_ENV=test", () => {
    expect(assertSafeToReset(`${HOST}/safwa_test_3`, "test")).toBe(
      "safwa_test_3",
    );
  });

  it("permits any underscore-separated suffix, including one that itself contains a disallowed word", () => {
    // Deliberately confirms the boundary: an underscore-joined suffix is
    // always a legitimate worker name in this scheme, however it reads —
    // "_prod" here does not make this name unsafe, because it is still
    // strictly a safwa_test_<worker> name, not a different database.
    expect(assertSafeToReset(`${HOST}/safwa_test_prod_shared`, "test")).toBe(
      "safwa_test_prod_shared",
    );
  });

  it.each([
    "safwa",
    "safwa_dev",
    "safwa_prod",
    "production",
    "postgres",
    "neondb",
  ])("refuses database name %s even under NODE_ENV=test", (name) => {
    expect(() => assertSafeToReset(`${HOST}/${name}`, "test")).toThrow(
      UnsafeTestDatabaseError,
    );
  });

  it.each(["development", "production"])(
    "refuses safwa_test under NODE_ENV=%s",
    (nodeEnv) => {
      expect(() => assertSafeToReset(`${HOST}/safwa_test`, nodeEnv)).toThrow(
        UnsafeTestDatabaseError,
      );
    },
  );

  it("refuses an unparsable DATABASE_URL", () => {
    expect(() => assertSafeToReset("not-a-valid-url", "test")).toThrow(
      UnsafeTestDatabaseError,
    );
  });

  it("rejects a name merely prefixed with safwa_test using a disallowed separator (e.g. safwa_test-production)", () => {
    // The pattern requires an underscore before any suffix, not just a
    // "safwa_test" prefix — guards against a substring-only check that
    // would wrongly accept "safwa_test-production" or "safwa_testXyz".
    expect(() =>
      assertSafeToReset(`${HOST}/safwa_test-production`, "test"),
    ).toThrow(UnsafeTestDatabaseError);
  });
});
