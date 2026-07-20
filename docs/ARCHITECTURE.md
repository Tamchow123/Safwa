# Safwa — Architecture

Status: planning baseline (Architecture Plan v4, approved 2026-07-14).

## 1. Recommended stack

| Concern            | Choice                                                 | Rationale                                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Framework          | **Next.js (App Router) + React + TypeScript (strict)** | One deployable; API routes co-located with the client; the study engine and question generator are shared TS modules that run identically in the browser and on the server (required for server-side question reconstruction); strongest tooling/agent familiarity |
| Styling / UI       | **Tailwind CSS + shadcn/ui (Radix primitives)**        | Accessible primitives (focus, ARIA, keyboard) out of the box; class-based dark mode; per-element `dir="rtl"` for Arabic content                                                                                                                                    |
| Client persistence | **Dexie (IndexedDB)**                                  | Guest progress, cached content releases, local causal event chains, offline mutation queue                                                                                                                                                                         |
| Spaced repetition  | **ts-fsrs**                                            | Maintained FSRS implementation; runs client-side for guests/offline and server-side for deterministic replay                                                                                                                                                       |
| Database / ORM     | **PostgreSQL (Neon) + Drizzle ORM**                    | Relational integrity (composite FKs, partial unique indexes, CHECKs are load-bearing in this design); typed schema; SQL migrations in-repo                                                                                                                         |
| Auth               | **Better Auth**                                        | TypeScript-native email/password, verification, reset, rate limiting; sessions via secure cookies; guests never blocked                                                                                                                                            |
| Email              | **Resend behind a provider-neutral adapter**           | Better Auth provides flows, not delivery; adapter (`sendEmail(template, to, data)`) keeps Postmark/SES swappable; local dev uses a console/file transport                                                                                                          |
| Validation         | **Zod**                                                | Shared schemas across client, server and content pipeline                                                                                                                                                                                                          |
| PWA / offline      | **Serwist**                                            | Next.js supplies the framework; **Serwist supplies the service worker, caching and offline integration**                                                                                                                                                           |
| Testing            | **Vitest + Testing Library + Playwright**              | See `TEST_STRATEGY.md`                                                                                                                                                                                                                                             |
| Hosting            | **Vercel + Neon** (assumed free tiers initially)       | See `DEPLOYMENT.md`                                                                                                                                                                                                                                                |

### Alternatives considered

| Alternative                          | Why rejected                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| SvelteKit                            | Capable, but smaller ecosystem for the accessible-component layer and less shared-module symmetry benefit           |
| Vite SPA + separate Hono/Express API | Two deployables and duplicated types for no benefit at this scale; breaks the shared question-generator requirement |
| Supabase (BaaS)                      | RLS poorly suited to the causal event-ingestion/replay model; heavier lock-in; auth is not the hard part here       |
| Firebase                             | Non-relational; the schema's integrity constraints are central                                                      |
| SQLite/Turso                         | Fine technically; Neon Postgres is equally cheap and more standard for the constraint set used                      |
| Auth.js                              | Weaker first-party email/password + verification story than Better Auth                                             |

### ADRs to create during Phase 1

- ADR-001 Single full-stack Next.js application
- ADR-002 Client-side FSRS with causal event-log sync and server replay
- ADR-003 Versioned immutable content releases; staged vocabulary persistence
- ADR-004 Study-component granularity `(entry, skill, source_field, direction)`
- ADR-005 Better Auth + Resend adapter
- ADR-006 Server-side canonical answer validation via assessment manifest +
  deterministic question regeneration
- ADR-007 No Postgres enums for evolving concepts; lookup tables + composite FK
  shape enforcement

## 2. Application architecture

Client-heavy single Next.js app. The learner experience (question generation,
session state machine, FSRS scheduling, progress computation) runs entirely
client-side against a cached content release — the identical code path for
guests, signed-in users and offline use. The server exists for: auth, event
ingestion/validation/reconciliation, cross-device state, analytics aggregates,
and (later) admin/content management.

```
apps (single Next.js app)
├── modules/content        content-release loading, Zod schemas, Dexie cache
├── modules/study-engine   PURE TS: component derivation, question generation,
│                          distractors, session state machine, attempts
├── modules/scheduler      PURE TS: ts-fsrs integration, rating mapping,
│                          event creation, causal chain, state projections
├── modules/study-session  session orchestration: plan builders/filters for
│                          the study modes (incl. weak-drill.ts, the exact
│                          weak-set planner) + the learner-state Dexie adapter
├── modules/collections    bookmark/list validation, canonicalisation and
│                          collection-axis filtering (pure) + persistence.ts,
│                          the Dexie adapter (uuidv7 list ids, Phase 14)
├── modules/profile        device profile, settings, session defaults, data
│                          export, timezone preference + THE effective-clock
│                          resolver (resolveEffectiveClock)
├── modules/sync           mutation queue, event push/pull, rebase handling
├── modules/auth           Better Auth config, email adapter
├── modules/analytics      PURE TS: date/activity/streak/progress formulas
│                          (Phase 12) + weakness heuristic v2, evidence
│                          preparation and group aggregation (Phase 13) +
│                          sanctioned Dexie adapters (daily_activity cache
│                          rebuild; weakness read, no cache write)
├── modules/admin          (phase 21) content operations
└── shared/arabic          normalisation, natural keys, extraction helpers
```

`study-engine`, `scheduler` and `analytics` are **pure TypeScript packages** —
no React, no DB imports, no ambient clocks (enforced by an ESLint purity
guard) — so they are unit-testable and importable by both the browser and the
server (which re-runs them for validation and replay). Two sanctioned
exceptions live in `modules/analytics`: `persistence.ts`, the browser-only
Dexie adapter that reads the analytics snapshot and atomically rebuilds the
`daily_activity` derived cache (DATA_MODEL.md §9), and `weakness-persistence.ts`
(Phase 13), the browser-only Dexie adapter that reads weakness evidence (no
cache write). Both are listed in `eslint.config.mjs`'s purity-guard ignores,
and the pure analytics barrel never re-exports either.

### Client/server responsibilities

| Concern                  | Client                                                 | Server                                                                                |
| ------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Question generation      | generates deterministically (seed + generator version) | reconstructs and validates the same question                                          |
| Correctness (objective)  | optimistic result for instant feedback                 | **authoritative** — derives `is_correct` + rating from the assessment manifest        |
| Correctness (flashcards) | subjective self-assessment                             | structural validation only (component exists, field eligible, rating ∈ {Good, Again}) |
| FSRS state               | optimistic local scheduling                            | **authoritative** after causal replay of accepted events                              |
| Content                  | consumes cached learner release                        | validates against validation + assessment manifests                                   |
| Guest data               | fully local (Dexie)                                    | none until merge                                                                      |

## 3. Content-release architecture

One publishing pipeline (Phase 3) reads the validated enriched JSON and emits
three immutable, checksummed artifacts sharing a `release_id`:

1. **Learner content release** (public, cached by clients): display fields,
   eligibility booleans, bāb/verb-type/page metadata. The `meaning` display
   field is the entry's BASE lexical gloss — not a literal English translation
   of each supplied inflected form; the UI labels it "Base meaning", and
   learner-facing form labels/grammatical descriptions come from one shared
   source-form metadata map (`lib/form-metadata.ts`). Every study consumer
   must honour the direction-specific contract: Arabic→English currently
   tests base-meaning recognition (the quizzed form may stay hidden until
   feedback), while English→Arabic must pair the base meaning with an
   explicit target-form instruction named BEFORE answering — the base gloss
   alone cannot identify which form is wanted. Exact form-specific English
   glosses would be a separately verified future content field. Excludes
   internal review provenance, generated additional forms and mazīd
   candidates.
2. **Validation manifest** (server): entry ids, per-entry field eligibility,
   allowed skills/directions/component shapes, bāb + verb-type ids, release
   status, checksums.
3. **Assessment manifest** (server-only trust boundary): canonical answer
   values/references per eligible entry (madi, mudari, masdar, ism_fail, amr,
   nahi, meaning, root, bab, verb_type).

Staging: until the admin phase, the enriched JSON + Python scripts are the
sole content-authoring authority and Postgres holds **no vocabulary tables**.
Phase 21 introduces operational content tables; publishing then flows from the
DB through the same pipeline. Exactly one editable authority exists at any
time (see `DATA_MODEL.md` §content versioning).

## 4. Authentication approach

- Email/password with mandatory email verification and password reset
  (Better Auth); optional Google OAuth may be added later if low-cost.
- Secure HTTP-only session cookies; CSRF protection on state-changing routes.
- Uniform responses on auth endpoints ("if an account exists, an email was
  sent") to prevent account enumeration; rate limiting on register / login /
  reset / resend endpoints.
- Guest use requires no auth anywhere in the learner flow.
- Admin authorisation: a `role` on users checked server-side per admin route;
  admin actions audit-logged.
- Account deletion: self-service, removes user rows and learning state
  (attempts/events), retains nothing personally identifiable.

## 5. PWA and offline approach

Next.js provides the web application framework, while **Serwist supplies the
service-worker, caching and offline/PWA integration.** Documented limitations
(also in `OFFLINE_AND_SYNC.md`):

- Installability is separate from full offline correctness.
- The Background Sync API is not uniformly available; the fallback is queue
  flush on app-open and `online` events.
- iOS PWA behaviour differs: Safari-only install path, stricter storage
  eviction, push only on recent iOS after install-to-home-screen.
- Offline sync ships in stages (online sync → offline queue → multi-device
  reconciliation) and is not claimed complete until cross-browser tested.

## 6. Data-import architecture

- Import/publish CLI (Phase 3) validates the JSON with Zod, checks the counts
  and eligibility statistics against `statistics`, and emits the three release
  artifacts. Deterministic: same input ⇒ byte-identical artifacts (modulo
  `created_at`).
- Idempotent by construction: artifacts are keyed by `release_id`; re-running
  for the same content version is a no-op.
- Immutable source ids (1–455, `mazid-NNNN`) are the join keys everywhere.
- Phase 21 DB import: idempotent upserts keyed on source id + content version;
  provenance columns preserved; original JSON retained as evidence.

## 7. Security considerations

- **Trust boundaries:** clients never determine objective correctness,
  ratings, eligibility or component validity — the server re-derives all of
  these from manifests and reconstructed questions; tampering attempts are
  rejected without FSRS effect and audit-logged (generic client responses).
- Input validation with Zod on every API boundary; no raw SQL from user input
  (Drizzle parameterisation).
- XSS: no `dangerouslySetInnerHTML` for user or content data; Arabic content
  is plain text.
- Secrets via environment variables only (`DEPLOYMENT.md` lists them); no
  secrets in the repo.
- Rate limiting on auth and sync endpoints; request-size limits on event
  batches.
- Security headers (CSP, frame-ancestors, referrer-policy) at the edge.

## 8. Observability (lightweight)

Structured JSON logs (server), Sentry free tier for error monitoring (client +
server), privacy-conscious product analytics (Vercel Analytics or self-hosted
Plausible — no cross-site tracking, no PII), `/api/health` check, Neon backup
posture per `DEPLOYMENT.md`. Sync-rejection and fallback-conflict logs are
first-class monitoring signals (they indicate bugs or tampering).
