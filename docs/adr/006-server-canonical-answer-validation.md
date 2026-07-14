# ADR-006: Server-side canonical answer validation

- Status: Accepted
- Date: 2026-07-14

## Context

The server must not trust client-submitted `is_correct`, ratings or answer
values for objective questions; a tampered client could otherwise fabricate
mastery. Server-recorded question instances were considered (strongest, but
hostile to guest/offline study and write-heavy), as was cryptographic signing
(unnecessary complexity).

## Decision

Answers are stable references (`{entry_id, field}`), never copied text. Each
question carries a deterministic specification (`question_seed`,
`question_generator_version`, component key, `content_version`,
`allowed_answer_refs`). The server reconstructs the question by re-running
the shared generator, resolves the canonical answer from the server-only
assessment manifest, and derives `is_correct` and the FSRS rating itself.
Flashcard self-assessment stays subjective but structurally validated
(Good/Again only). Tampering is rejected without FSRS effect and audit-logged.

## Consequences

One code path validates online and offline attempts; guests stay fully local
until merge. Old generator versions must remain loadable server-side, and the
generator must be strictly deterministic (injected RNG/clock, no Date.now).
