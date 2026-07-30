import { describe, expect, it } from "vitest";

import type { useSession } from "@/modules/auth/client";
import {
  accountIdFromSession,
  classifySessionIdentity,
  type ClassifiableSession,
  type SessionIdentity,
} from "@/modules/auth/session-identity";
import { OWNER_ACCOUNT_ID_MAX_LENGTH } from "@/modules/content/owner-key";

const ACCOUNT_ID = "9f1c4d2e-7a3b-4c5d-8e6f-0a1b2c3d4e5f";

/** A signed-in snapshot, shaped like Better Auth's resolved `useSession()`. */
function signedIn(id: string = ACCOUNT_ID): ClassifiableSession {
  return { data: { user: { id } }, isPending: false, error: null };
}

/**
 * Every row of the Phase 18 §2 identity contract, as data. The table IS the
 * specification: a change to the classifier that is not reflected here is a
 * change to the contract, and should have to edit this table to land.
 */
const CONTRACT: ReadonlyArray<{
  name: string;
  session: ClassifiableSession | null | undefined;
  expected: SessionIdentity;
}> = [
  {
    name: "a valid account id is an account",
    session: signedIn(),
    expected: { kind: "account", accountId: ACCOUNT_ID },
  },
  {
    name: "still-in-flight (isPending) is unknown, never guest",
    session: { data: null, isPending: true, error: null },
    expected: { kind: "unknown" },
  },
  {
    name: "the server answered and said nobody is signed in: guest",
    session: { data: null, isPending: false, error: null },
    expected: { kind: "guest" },
  },
  {
    name: "a 401 is a real answer from a reachable server: guest",
    session: { data: null, isPending: false, error: { status: 401 } },
    expected: { kind: "guest" },
  },
  {
    name: "a 500 says nothing about the learner: unknown",
    session: { data: null, isPending: false, error: { status: 500 } },
    expected: { kind: "unknown" },
  },
  {
    name: "the 503 of a deployment with AUTH_ENABLED=false: unknown",
    session: { data: null, isPending: false, error: { status: 503 } },
    expected: { kind: "unknown" },
  },
  {
    name: "a network rejection carries no status at all: unknown",
    // What `.catch()` in better-auth's query store actually stores for an
    // offline fetch: the raw thrown value, typically a TypeError, which is NOT
    // a BetterFetchError and so has no `status` property whatsoever.
    session: { data: null, isPending: false, error: {} },
    expected: { kind: "unknown" },
  },
  {
    name: "no snapshot at all is an absence of information, not a guest",
    session: undefined,
    expected: { kind: "unknown" },
  },
];

describe("classifySessionIdentity — the Phase 18 §2 contract", () => {
  for (const row of CONTRACT) {
    it(row.name, () => {
      expect(classifySessionIdentity(row.session)).toEqual(row.expected);
    });
  }

  it("covers every row of the contract table", () => {
    // Guards against a row being deleted rather than fixed when the contract
    // changes: the count is asserted, so a silent removal fails here.
    expect(CONTRACT).toHaveLength(8);
    const kinds = new Set(CONTRACT.map((row) => row.expected.kind));
    expect([...kinds].sort()).toEqual(["account", "guest", "unknown"]);
  });
});

describe("the offline cold boot — the defect this module exists to fix", () => {
  it("classifies a rejected session fetch as unknown, not guest", () => {
    // The EXACT state better-auth's store lands in on a cold boot with no
    // network while signed in: the fetch rejected, so `isPending` is already
    // false and `data` was never populated. `data?.user?.id ?? null` reports
    // guest here; that is the bug.
    const coldBootOffline: ClassifiableSession = {
      data: null,
      isPending: false,
      error: { status: 0 },
    };

    expect(classifySessionIdentity(coldBootOffline)).toEqual({
      kind: "unknown",
    });
    expect(accountIdFromSession(coldBootOffline)).toBeNull();
  });

  it("keeps classifying the account when a refresh fails but data survives", () => {
    // better-auth retains `data` across a NON-401 failure (query.mjs's onError
    // sets `data: isUnauthorized ? null : value.get().data`), so a signed-in
    // learner whose periodic refresh fails offline stays themselves.
    const refreshFailedWhileSignedIn: ClassifiableSession = {
      data: { user: { id: ACCOUNT_ID } },
      isPending: false,
      error: { status: 500 },
    };

    expect(classifySessionIdentity(refreshFailedWhileSignedIn)).toEqual({
      kind: "account",
      accountId: ACCOUNT_ID,
    });
  });

  it("does not claim guest merely because an error is present", () => {
    // The inverse guard: `error` alone must never downgrade to guest. Only a
    // 401 or an outright absence of error may.
    for (const status of [0, 408, 429, 500, 502, 503, 504]) {
      expect(
        classifySessionIdentity({
          data: null,
          isPending: false,
          error: { status },
        }),
      ).toEqual({ kind: "unknown" });
    }
  });

  it("only null/undefined mean 'no error' — a falsy non-error is still an error", () => {
    // Types are erased at runtime. Only an explicit absence may answer guest;
    // a dependency that one day rejected with `0`, `false` or `""` must not be
    // mistaken for "the server answered, nobody is signed in".
    for (const falsy of [0, false, "", Number.NaN]) {
      expect(
        classifySessionIdentity({
          data: null,
          isPending: false,
          error: falsy as unknown as null,
        }),
      ).toEqual({ kind: "unknown" });
    }

    // ...while the two genuine absences still do mean guest.
    for (const absent of [null, undefined]) {
      expect(
        classifySessionIdentity({
          data: null,
          isPending: false,
          error: absent,
        }),
      ).toEqual({ kind: "guest" });
    }
  });
});

describe("a present user with an unusable id is unknown, never guest", () => {
  // The server said SOMEBODY is signed in. Answering guest would re-create the
  // silent mis-scoping this module prevents; answering account is impossible,
  // because accountOwnerKey() throws on exactly these values.
  const unusable: ReadonlyArray<{ name: string; id: unknown }> = [
    { name: "an empty string", id: "" },
    { name: "a whitespace-padded id", id: ` ${ACCOUNT_ID} ` },
    {
      name: "an over-length id",
      id: "x".repeat(OWNER_ACCOUNT_ID_MAX_LENGTH + 1),
    },
    { name: "a non-string", id: 12345 },
    { name: "a missing id", id: undefined },
    { name: "a null id", id: null },
  ];

  for (const { name, id } of unusable) {
    it(`rejects ${name}`, () => {
      const session = {
        data: { user: { id } },
        isPending: false,
        error: null,
      } as unknown as ClassifiableSession;

      expect(classifySessionIdentity(session)).toEqual({ kind: "unknown" });
      expect(accountIdFromSession(session)).toBeNull();
    });
  }

  it("accepts an id at exactly the maximum length", () => {
    const id = "x".repeat(OWNER_ACCOUNT_ID_MAX_LENGTH);
    expect(classifySessionIdentity(signedIn(id))).toEqual({
      kind: "account",
      accountId: id,
    });
  });

  it("treats a null user as an ordinary signed-out shape, not an unusable id", () => {
    // `data: { user: null }` must fall through to the ordinary rules and reach
    // guest — it is not the "somebody is signed in but the id is broken" case.
    expect(
      classifySessionIdentity({
        data: { user: null },
        isPending: false,
        error: null,
      }),
    ).toEqual({ kind: "guest" });
  });
});

describe("accountIdFromSession", () => {
  it("returns the id for an account", () => {
    expect(accountIdFromSession(signedIn())).toBe(ACCOUNT_ID);
  });

  it("returns null for a guest AND for unknown — the caller must not conflate them", () => {
    expect(
      accountIdFromSession({ data: null, isPending: false, error: null }),
    ).toBeNull();
    expect(
      accountIdFromSession({ data: null, isPending: true, error: null }),
    ).toBeNull();
  });
});

describe("it fits Better Auth's real session without a cast", () => {
  it("accepts ReturnType<typeof useSession> as-is", () => {
    // A COMPILE-TIME proof; the runtime assertion is incidental. If Better
    // Auth's real `useSession()` value were not assignable to
    // ClassifiableSession — most likely because `error` stopped existing or
    // stopped carrying `status: number` — this line would fail `pnpm
    // typecheck`, which is the check that matters here. The import is
    // type-only, so nothing constructs an auth client in this unit test.
    const classify: (
      session: ReturnType<typeof useSession>,
    ) => SessionIdentity = classifySessionIdentity;

    expect(classify).toBe(classifySessionIdentity);
  });
});

describe("purity", () => {
  it("does not mutate the snapshot it is given", () => {
    const session = signedIn();
    const before = JSON.stringify(session);
    classifySessionIdentity(session);
    expect(JSON.stringify(session)).toBe(before);
  });

  it("returns a stable reference for the data-free verdicts", () => {
    // Guest and unknown carry no payload, so the module hands back singletons;
    // consumers may use them in dependency arrays without churn.
    const a = classifySessionIdentity({ isPending: true });
    const b = classifySessionIdentity({ isPending: true });
    expect(a).toBe(b);
  });
});
