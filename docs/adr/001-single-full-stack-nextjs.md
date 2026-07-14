# ADR-001: Single full-stack Next.js application

- Status: Accepted
- Date: 2026-07-14

## Context

Safwa needs a responsive, PWA-capable web app whose study engine and question
generator must run identically in the browser (guests, offline) and on the
server (validation, deterministic question reconstruction). Alternatives
considered: SvelteKit, a Vite SPA with a separate Hono/Express API, Supabase
BaaS, Firebase (see `docs/ARCHITECTURE.md` §1).

## Decision

One Next.js (App Router) application with strict TypeScript hosts the client,
API routes and shared pure-TS modules (`modules/study-engine`,
`modules/scheduler`). No separate backend service.

## Consequences

One deployable and one type system; shared modules eliminate client/server
generator drift. We accept coupling to the Next.js release cycle; the pure
modules keep core logic portable if the framework ever changes.
