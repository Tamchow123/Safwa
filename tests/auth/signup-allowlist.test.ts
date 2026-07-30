import { describe, expect, it } from "vitest";

import {
  isSignupAllowed,
  parseSignupAllowlist,
  SignupAllowlistConfigError,
} from "@/modules/auth/signup-allowlist";

/**
 * The whole point of this module is that a configuration mistake fails CLOSED.
 * So the tests are organised around the two directions a mistake can go: a
 * setting that should have allowed someone and did not (annoying), and a
 * setting that should have refused someone and did not (the bug that lets a
 * stranger onto a personal instance).
 */
describe("parseSignupAllowlist", () => {
  describe("no allowlist configured", () => {
    it.each([
      ["undefined", undefined],
      ["empty string", ""],
      ["whitespace only", "   \t \n "],
    ])("returns null for %s", (_label, raw) => {
      expect(parseSignupAllowlist(raw)).toBeNull();
    });
  });

  describe("a configured allowlist", () => {
    it("parses a single address", () => {
      expect(parseSignupAllowlist("owner@example.test")).toEqual([
        "owner@example.test",
      ]);
    });

    it("parses a comma-separated list, trimming each entry", () => {
      expect(
        parseSignupAllowlist(" one@example.test , two@example.test "),
      ).toEqual(["one@example.test", "two@example.test"]);
    });

    it("lower-cases every entry so the stored form is the comparison form", () => {
      expect(parseSignupAllowlist("Owner@Example.TEST")).toEqual([
        "owner@example.test",
      ]);
    });

    it("de-duplicates case-variant repeats while preserving order", () => {
      expect(
        parseSignupAllowlist(
          "b@example.test, A@example.test, a@example.test, b@example.test",
        ),
      ).toEqual(["b@example.test", "a@example.test"]);
    });

    it("accepts an address at the 254-character limit", () => {
      const local = "a".repeat(254 - "@example.test".length);
      const address = `${local}@example.test`;
      expect(address).toHaveLength(254);
      expect(parseSignupAllowlist(address)).toEqual([address]);
    });
  });

  describe("a configured allowlist that is wrong", () => {
    // Every case here would, if it silently produced `null`, turn a deployment
    // the operator believed was closed into an open one.
    it.each([
      ["a bare word", "not-an-email"],
      ["a missing local part", "@example.test"],
      ["a missing domain", "owner@"],
      ["two @ signs", "owner@@example.test"],
      ["an internal space", "own er@example.test"],
      ["an over-length address", `${"a".repeat(242)}@example.test`],
    ])("throws on %s", (_label, raw) => {
      expect(() => parseSignupAllowlist(raw)).toThrow(
        SignupAllowlistConfigError,
      );
    });

    it.each([
      ["a trailing comma", "owner@example.test,"],
      ["a leading comma", ",owner@example.test"],
      ["a doubled comma", "one@example.test,,two@example.test"],
      ["commas only", ",,,"],
    ])("throws on %s rather than quietly dropping it", (_label, raw) => {
      expect(() => parseSignupAllowlist(raw)).toThrow(
        SignupAllowlistConfigError,
      );
    });

    it("names the failing position but never echoes the address", () => {
      const secret = "someone.private@example.test";
      try {
        parseSignupAllowlist(`${secret},broken`);
        expect.unreachable("expected parseSignupAllowlist to throw");
      } catch (error) {
        expect(String(error)).toContain("entry 2");
        expect(String(error)).not.toContain(secret);
        expect(String(error)).not.toContain("broken");
      }
    });

    it("never returns null for a value that was set but unusable", () => {
      // The distinction the type comment relies on: `null` means "not
      // configured", and only an absent/blank value may produce it.
      for (const raw of ["not-an-email", ",", " , "]) {
        expect(() => parseSignupAllowlist(raw)).toThrow();
      }
    });

    it("never returns an empty list — and an empty list would fail closed anyway", () => {
      // Two separate guarantees. The parse is non-empty by construction, so
      // nothing can produce `[]`; and even if that changed, `[]` refuses
      // everything, where only `null` opens sign-up. Both directions are
      // asserted because only the second one is safe to be wrong about.
      for (const raw of [
        "owner@example.test",
        "a@x.test,a@x.test",
        " b@x.test ",
      ]) {
        expect(parseSignupAllowlist(raw)).not.toHaveLength(0);
      }
      expect(isSignupAllowed("anyone@example.test", [])).toBe(false);
    });
  });
});

describe("isSignupAllowed", () => {
  it("allows anything when no allowlist is configured", () => {
    expect(isSignupAllowed("stranger@example.test", null)).toBe(true);
  });

  it("allows a listed address", () => {
    const list = parseSignupAllowlist("owner@example.test");
    expect(isSignupAllowed("owner@example.test", list)).toBe(true);
  });

  it("allows a listed address whose case differs", () => {
    const list = parseSignupAllowlist("owner@example.test");
    expect(isSignupAllowed("Owner@Example.Test", list)).toBe(true);
  });

  it("allows a listed address with surrounding whitespace", () => {
    const list = parseSignupAllowlist("owner@example.test");
    expect(isSignupAllowed("  owner@example.test  ", list)).toBe(true);
  });

  it("refuses an address that is not listed", () => {
    const list = parseSignupAllowlist("owner@example.test");
    expect(isSignupAllowed("stranger@example.test", list)).toBe(false);
  });

  it("refuses a plus-address alias of a listed address", () => {
    // Documented, deliberate: alias rules belong to someone else's mail
    // server, and guessing them in the permissive direction is the whole
    // failure mode this module exists to prevent.
    const list = parseSignupAllowlist("owner@example.test");
    expect(isSignupAllowed("owner+alias@example.test", list)).toBe(false);
  });

  it("refuses a superstring and a substring of a listed address", () => {
    const list = parseSignupAllowlist("owner@example.test");
    expect(isSignupAllowed("owner@example.test.attacker.example", list)).toBe(
      false,
    );
    expect(isSignupAllowed("wner@example.test", list)).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an object", { email: "owner@example.test" }],
    ["an array", ["owner@example.test"]],
  ])("refuses a non-string email (%s)", (_label, email) => {
    const list = parseSignupAllowlist("owner@example.test");
    expect(isSignupAllowed(email, list)).toBe(false);
  });

  it("matches any address in a multi-entry list", () => {
    const list = parseSignupAllowlist("one@example.test,two@example.test");
    expect(isSignupAllowed("one@example.test", list)).toBe(true);
    expect(isSignupAllowed("two@example.test", list)).toBe(true);
    expect(isSignupAllowed("three@example.test", list)).toBe(false);
  });
});
