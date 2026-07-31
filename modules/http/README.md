# `modules/http` — request-shaping infrastructure for this app's own API routes

Two concerns that are **not** owned by any feature module, because more than
one feature's routes need them and none of them owns the others:

- `rate-limit.ts` — a fixed-window, per-account request ceiling backed by the
  `api_rate_limits` table (migration 0007).
- `request-origin.ts` — the same-origin assertion applied to state-changing and
  session-bearing routes.
- `rate-limited-response.ts` — the one 429 response shape, so four routes do not
  each invent their own.
- `request-body.ts` — `readBoundedBody`, which streams a request body against a
  hard byte cap without trusting `Content-Length`.

## Why this module exists rather than living in `modules/sync`

These started in `modules/sync/server` (and `request-origin.ts` in
`modules/auth`), and the Phase 18.1 council was right to object:
`app/api/account/settings` imported them, which is not a sync route.
`request-body.ts` joined them a review round later, for exactly the same reason
and found by exactly the same argument — giving the settings route a byte cap
made a third sync-namespaced file cross-feature. `modules/sync/README.md` scopes that module to "the outbound mutation
queue, event push/pull, client rebase handling and sync-status state", and a
reader trusting that scope would not expect account settings to break when they
refactored it.

So the rule for this module is narrow and worth keeping narrow: **something
belongs here only if it shapes an HTTP request/response for routes across more
than one feature, and carries no feature's domain knowledge.** Rate limiting and
origin checking qualify. Anything that knows what a study component is does not.

## What is deliberately NOT here

- **Authentication and session handling** stay in `modules/auth`. This module
  runs _before_ them and must not depend on them — `request-origin.ts` is
  checked before the session is read, precisely so a refusal cannot reveal
  whether a session exists.
- **The sync guard itself** (`modules/sync/server/auth-guard.ts`) stays in
  `modules/sync`, because it also enforces the `SYNC_ENABLED` kill switch and
  the email-verification rule, which are sync's own policy. It _consumes_ this
  module; it does not belong to it.

## Things to know before changing these files

- **The limiter fails open, and fails open fast.** Both halves are deliberate
  and both are pinned by tests. See the docblock in `rate-limit.ts` — the "fast"
  half exists because the pool's `statement_timeout` is 10s, and a slow database
  would otherwise have added that to every request on four routes.
- **The origin check fails safe** (absent headers are allowed) and treats the
  request's own host as same-origin alongside the configured `appUrl`. Removing
  that second candidate breaks every Vercel preview deployment. The test named
  "accepts a host the app was reached on but is not configured as" is the guard
  against that regression.
- **`api_rate_limits` is not Better Auth's `rate_limits` table**, and must not
  be consolidated with it. Better Auth prunes its own table with a predicate
  that has no key filter. See `db/schema/rate-limit.ts`.

Tests are colocated (`*.test.ts`), matching `modules/sync/**`, and are picked up
by `vitest.config.ts`'s `modules/**` include glob.
