# ADR-011: SMTP submission replaces Resend for transactional email

- Status: Accepted
- Date: 2026-11-15
- Supersedes: the email-provider half of ADR-005 (Better Auth stands)

## Context

ADR-005 put transactional email behind a provider-neutral adapter, backed by
Resend. Resend delivers to arbitrary recipients only from a verified sending
domain; without one it sends only to the Resend account owner's own address.
The owner of this personal instance will not own a domain for it. Email is a
hard dependency — sign-in and sync both refuse an unverified account, and
password reset and account deletion are confirmed by emailed links — so the
first production deploy was blocked on it.

(ADR-010 is not skipped by accident: `docs/phases/phases-18.md` reserves it for
the departure from Serwist that Phase 18's slice-9 decision point would have
recorded, and `scripts/verify-service-worker.ts` still names it as that
fallback.)

## Decision

Replace Resend with a generic SMTP submission transport
(`modules/email/transports/smtp.ts`, nodemailer) behind the same
`EmailTransport` adapter, documented for Gmail with an app password on a
dedicated sending-only account (`docs/DEPLOYMENT.md` §2a). Remove Resend
entirely rather than keep it as a fallback: an unused transport is untested
surface.

- TLS is mandatory and the certificate always verified. `SMTP_PORT` is limited
  to 465 (TLS) and 587 (STARTTLS with `requireTLS`) in every environment,
  because the port is what selects the TLS mode.
- Delivery semantics are unchanged: one bounded attempt, scheduled with
  `after()` so response timing cannot enumerate accounts, logging that carries
  codes only. No connection pool, since a frozen serverless instance would hold
  a dead socket.
- SMTP has no idempotency header, so the idempotency key becomes a
  deterministic `Message-ID` (a hash, never the token).

## Consequences

- No domain is needed, and any submission server works with the same five
  variables, so the next change of provider is configuration rather than code.
- A Gmail app password is not send-only: it also grants IMAP access to the
  whole mailbox. Hence the dedicated account holding nothing else
  (`RISK_REGISTER.md` risk 32).
- Gmail's consumer limit (roughly 500 recipients a day) is far above a personal
  instance's needs; without a domain of one's own, a first message may be
  filtered as spam.
- Delivery runs inside the auth route's lifetime, so that route now declares a
  `maxDuration` (60s) that outlasts the send bound.
- Deferred: OAuth2 (XOAUTH2) instead of an app password — a narrower
  credential, but it needs a Google Cloud project and refresh-token handling.
  Reopened if Google withdraws app passwords for the account, or the mailbox
  scope of an app password is judged too broad a risk.
