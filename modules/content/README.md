# modules/content

Content pipeline and client content store (Phase 3).

## Files

| File                  | Runs in          | Purpose                                                                                                     |
| --------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `constants.ts`        | both             | generator version, field/skill/direction/shape catalogues, expected invariants                              |
| `stable-json.ts`      | both             | deterministic serializer (sorted keys, trailing newline)                                                    |
| `schema.ts`           | both             | strict Zod schemas for all generated artifacts + cache records                                              |
| `source-schema.ts`    | both             | loose Zod schema for the enriched source dataset                                                            |
| `answer-reference.ts` | both             | stable `entry:<id>:field:<field>` answer references (ADR-006)                                               |
| `build.ts`            | **Node only**    | `pnpm content:build` — emits learner release, validation + assessment manifests, checksums, active pointer  |
| `checksum.ts`         | **Node only**    | SHA-256 via node:crypto                                                                                     |
| `db.ts`               | **browser only** | Dexie schema v1 (contentReleases / contentEntries / contentMetadata), transactional caching                 |
| `load.ts`             | **browser only** | pointer fetch → cache check → verified download → transactional cache → typed result, with offline fallback |
| `index.ts`            | browser-safe     | re-exports (excludes Node-only files)                                                                       |

## Content identity

- **`release_id` is the authoritative identifier for the exact approved
  content release.** It is derived from the SHA-256 of the full release
  basis (versions + generator version + learner entries + structural
  validation rules/skill metadata/per-entry validation metadata +
  assessment canonical answers). Future question instances, attempts and
  sync events must carry `release_id`.
- `content_version` is human-readable dataset metadata only — it does NOT
  uniquely identify an exact release and must never be used as one.
- Immutable artifacts carry no timestamps (a source `generated_at`-only
  change produces identical bytes and the same id). Release files are
  never overwritten with different bytes: identical bytes are an
  idempotent no-op, different bytes fail the build.
- Lifecycle status and protocol support live in the mutable
  `content-server/release-registry.json` (operational state), never inside
  an immutable artifact.

## Rules

- The enriched JSON + Python scripts are the sole content-authoring
  authority (ADR-003); generated artifacts are immutable per release id and
  never edited by hand.
- `content-server/` artifacts are a server trust boundary — never imported
  into browser code, never served publicly.
- Determinism: identical input ⇒ byte-identical artifacts. Immutable
  artifacts contain no timestamps at all; the source `generated_at` is
  ignored for both release identity and artifact bytes.
- Eligibility is copied from approved metadata; presence of a value never
  implies quiz eligibility. Generated forms and mazīd candidates never ship.
