# ADR-003: Versioned immutable content releases; staged vocabulary persistence

- Status: Accepted
- Date: 2026-07-14

## Context

Learner content originates from the validated enriched JSON with mandatory
field-level quiz eligibility. Early Postgres vocabulary tables would create a
second editable copy with no consumer until the admin phase.

## Decision

One pipeline publishes three immutable, checksummed artifacts per release id:
the learner content release (public, cached), a structural validation
manifest and a server-only assessment manifest. Until Phase 21 the enriched
JSON is the sole authoring authority and Postgres holds no vocabulary tables;
the admin phase cuts over to DB-authored content published through the same
pipeline. Old releases stay sync-compatible indefinitely unless revoked for
cause.

## Consequences

Offline caching, session pinning and long-offline recovery are simple and
safe; ineligible content is excluded at build time. The Phase 21 cutover must
be explicit and one-way to avoid dual editable authorities.
