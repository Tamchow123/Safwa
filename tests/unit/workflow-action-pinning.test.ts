import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every GitHub Action is pinned to a commit, checked rather than trusted
 * (Phase 18.1).
 *
 * A reference like `actions/checkout@v4` is a MOVING target: the tag is a
 * pointer the publisher can repoint at any commit, and anyone who compromises
 * that account can repoint it too. The workflows this repository runs are not
 * a good place to accept that. `deploy-migrate.yml` runs with
 * PRODUCTION_DATABASE_URL_DIRECT, PRODUCTION_BETTER_AUTH_SECRET,
 * PRODUCTION_RESEND_API_KEY and NEON_API_KEY already exported into the job
 * environment; `backup.yml` handles the production dump. In both, "the action's
 * code silently changed" and "an attacker ran code next to the production
 * credentials" are the same sentence.
 *
 * This is not hypothetical drift-policing. When these pins were first
 * resolved, `pnpm/action-setup@v4` did NOT point at v4.4.0, the newest release
 * in its own major — the moving tag lagged behind by a release. That is the
 * mechanism working exactly as described: what the tag says and what the tag
 * runs are different questions.
 *
 * The version comment is required alongside the SHA because a bare 40-hex
 * string is unreviewable — nobody can tell an intentional upgrade from a
 * hostile one in a diff of two hashes. The comment is what makes the pin
 * legible; this test is what stops it being decorative.
 *
 * What this does NOT check: that a pinned SHA is the commit the version
 * comment claims. That needs the network, which a unit test must not touch.
 * Verify with `git ls-remote https://github.com/<action> refs/tags/<version>^{}`
 * when reviewing a change to a pin.
 */
const WORKFLOW_DIR = join(process.cwd(), ".github", "workflows");

/** `uses:` steps only; `with:`/`run:` lines can legitimately contain an @. */
const USES_LINE = /^\s*(?:-\s*)?uses:\s*(\S+)/;

/** A 40-character hex commit id — the only reference form accepted below. */
const PINNED = /^[0-9a-f]{40}$/;

type Use = { workflow: string; line: number; ref: string; comment: string };

function collectUses(): Use[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .flatMap((workflow) => {
      const text = readFileSync(join(WORKFLOW_DIR, workflow), "utf8");
      return text.split(/\r?\n/).flatMap((raw, index) => {
        const match = USES_LINE.exec(raw);
        if (match === null) return [];
        return [
          {
            workflow,
            line: index + 1,
            ref: match[1] ?? "",
            comment: raw.slice(raw.indexOf(match[1] ?? "")).split("#")[1] ?? "",
          },
        ];
      });
    });
}

const uses = collectUses();

describe("GitHub Action pinning", () => {
  it("finds the workflows, so a renamed directory cannot vacuously pass", () => {
    expect(uses.length).toBeGreaterThan(0);
  });

  it.each(uses.map((u) => [`${u.workflow}:${u.line}`, u] as const))(
    "%s is pinned to a commit SHA",
    (_label, use) => {
      // A local composite action (`./.github/actions/...`) is this repository's
      // own reviewed code and needs no pin. Nothing else is exempt.
      if (use.ref.startsWith("./")) return;

      const [, reference] = use.ref.split("@");
      expect(
        reference,
        `${use.workflow}:${use.line} uses "${use.ref}". A tag or branch is a moving pointer the publisher (or whoever compromises them) can repoint. Pin it: resolve the commit with \`git ls-remote https://github.com/<action> "refs/tags/<version>^{}"\` and write \`<action>@<sha> # <version>\`.`,
      ).toMatch(PINNED);
    },
  );

  it.each(uses.map((u) => [`${u.workflow}:${u.line}`, u] as const))(
    "%s records which version its SHA is",
    (_label, use) => {
      if (use.ref.startsWith("./")) return;
      expect(
        use.comment.trim(),
        `${use.workflow}:${use.line} pins a SHA with no version comment. Two hashes in a diff are unreviewable — nobody can distinguish an intended upgrade from a hostile repin. Append \`# v<x.y.z>\`.`,
      ).toMatch(/^v?\d+\.\d+/);
    },
  );
});
