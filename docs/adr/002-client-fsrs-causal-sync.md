# ADR-002: Client-side FSRS with causal event-log synchronisation

- Status: Accepted
- Date: 2026-07-14

## Context

Guests and offline users need full scheduling without a server; multi-device
accounts need convergent state. Last-write-wins on FSRS state silently
destroys reviews and double-advances mastery (see `docs/OFFLINE_AND_SYNC.md`
§5).

## Decision

ts-fsrs runs client-side. Every scheduling action is an immutable review
event carrying causal lineage (`parent_event_id`, `base_server_revision`,
`client_component_revision`). Authoritative server state is the deterministic
replay of accepted events in causal (topological) order; concurrent branches
resolve by the pessimistic-rating rule and losing branches (with scheduling
descendants) are demoted to reinforcement.

## Consequences

Sequential offline reviews are preserved; conflicts resolve deterministically
without double advancement. Costs: DAG ingestion complexity (pending parents,
cycles, TTL) — mitigated by staged rollout (Phases 16 → 18 → 19) and pure,
property-tested replay functions.
