# ADR-005: Better Auth with a provider-neutral Resend email adapter

- Status: Accepted
- Date: 2026-07-14

## Context

Safwa needs optional email/password accounts (verification, reset, rate
limiting) that never block guest study, plus actual email delivery — an auth
library alone does not send email. Auth.js was considered but has a weaker
first-party email/password story.

## Decision

Better Auth provides the auth flows with secure cookie sessions. Transactional
email goes through a provider-neutral adapter (`sendEmail(template, to,
data)`) backed by Resend in production and a console/file transport in
development. Responses are enumeration-safe.

## Consequences

TypeScript-native auth with minimal custom code; Resend is swappable
(Postmark/SES) without touching auth logic. Sender-domain setup (SPF/DKIM)
and delivery-failure handling are operational requirements documented in
`docs/DEPLOYMENT.md`.
