# ADR-004: Study-component granularity

- Status: Accepted
- Date: 2026-07-14

## Context

A learner may know the māḍī but not the maṣdar, or recognise Arabic→English
without recalling English→Arabic. One card per word would produce misleading
mastery; one card per (word × form × direction × every skill) would fragment
prompt-independent knowledge like bāb identification.

## Decision

Translation skills use components keyed
`(entry_id, skill_type, source_field, direction)` over the six source forms.
Bāb, root and verb-type identification use one component per
`(entry_id, skill_type)` with the prompt form recorded on the attempt.
Components materialise lazily on first attempt; progress denominators derive
from the content release's eligibility matrix. PostgreSQL enforces shape via
a composite FK to `skill_types(id, component_shape)` plus shape-predicated
partial unique indexes; Dexie mirrors identity via natural-key primary keys.

## Consequences

~6,800 components ceiling per user (acceptable); honest per-form/per-direction
mastery; entry-level skills schedule as single facts. Word-level state is a
projection over essential components (`docs/PRODUCT_REQUIREMENTS.md` §5–6).
