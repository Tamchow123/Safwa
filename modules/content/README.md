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

## Rules

- The enriched JSON + Python scripts are the sole content-authoring
  authority (ADR-003); generated artifacts are immutable per release id and
  never edited by hand.
- `content-server/` artifacts are a server trust boundary — never imported
  into browser code, never served publicly.
- Determinism: identical input ⇒ byte-identical artifacts (`created_at`
  comes from the dataset's `generated_at`, never wall-clock).
- Eligibility is copied from approved metadata; presence of a value never
  implies quiz eligibility. Generated forms and mazīd candidates never ship.
