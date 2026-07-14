# ADR-007: No PostgreSQL enums for evolving concepts

- Status: Accepted
- Date: 2026-07-14

## Context

Skill types will grow (typed answers, form transformation, pronoun
conjugation, mazīd, audio); bāb and verb type are content taxonomies that
must stay aligned with imported datasets. PostgreSQL enum alterations are
risky, migration-heavy and block additive evolution.

## Decision

Evolving concepts use lookup tables with stable string identifiers
(`skill_types` with `component_shape`, `babs`, `verb_types`) or constrained
text with CHECK constraints, always paired with TypeScript string-literal
unions and Zod validation. New skills and even new component shapes arrive
via additive inserts/migrations. PostgreSQL enums are avoided project-wide.

## Consequences

Additive evolution without enum-replacement migrations; the database still
enforces structure via CHECKs and the composite `(skill_type_id,
component_shape)` foreign key (ADR-004). Application-level validation (Zod)
carries the semantic rules the database cannot express.
