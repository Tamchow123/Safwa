/**
 * Password length bounds (Phase 15, phases-15.md §30) — the single
 * source of truth shared by `modules/auth/server.ts` (where Better Auth
 * actually enforces them) and any client-side form that needs to display
 * or pre-validate against the same bounds. Deliberately isomorphic (no
 * `server-only`/`"use client"` marker) so both sides can import it
 * without drifting out of sync.
 */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
