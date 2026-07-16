# AGENTS.md

## Repository purpose

This repository uses Claude Code as the primary implementation agent and Codex as an independent pull-request reviewer.

Codex should review changes independently rather than assuming the implementation approach is correct.

## General review approach

Review the complete pull-request diff against the base branch.

Read surrounding code when necessary to understand the behaviour being changed. Do not judge a change from isolated lines when its correctness depends on other files.

Focus on defects that are actionable and introduced by the pull request.

Do not report:

- Purely subjective style preferences.

- Formatting issues already handled by automated tooling.

- Existing problems unrelated to the pull request.

- Hypothetical risks without a realistic failure scenario.

- Minor naming preferences unless they cause genuine confusion or incorrect behaviour.

Every finding must include:

- The affected file and relevant lines.

- The concrete failure scenario.

- Why it matters.

- A practical recommended correction.

## Review priorities

Treat the following as high-priority findings.

### Correctness and regressions

- Flag logic that does not meet the stated acceptance criteria.

- Flag behavioural regressions introduced by the change.

- Check boundary conditions, empty values, null values and invalid states.

- Check that error paths behave correctly, not only successful paths.

- Check that asynchronous operations are awaited and handled correctly.

- Check for race conditions, stale state and incorrect ordering assumptions.

- Verify that changes work consistently across all affected call sites.

### Authentication and authorisation

- Verify that protected actions require authentication.

- Verify that authorisation is enforced server-side.

- Flag cases where users can access or modify another user’s data.

- Flag reliance on client-side permission checks for security.

- Check that newly added endpoints follow existing authentication and authorisation patterns.

### Security and privacy

- Flag exposed secrets, credentials, API keys or access tokens.

- Flag injection vulnerabilities, including SQL, command, template and script injection.

- Flag unsafe deserialisation or unvalidated external input.

- Flag sensitive information written to logs.

- Do not allow passwords, tokens, personal data or authentication headers to be logged.

- Check for insecure direct object references.

- Check whether dependency changes introduce unnecessary security risk.

### Data integrity

- Flag operations that can unintentionally delete, overwrite, duplicate or corrupt data.

- Review database migrations for destructive or irreversible changes.

- Check transaction boundaries where multiple operations must succeed together.

- Check uniqueness, foreign-key and validation requirements.

- Check that retries cannot accidentally create duplicate records.

- Flag incompatible schema and application-code changes.

### APIs and compatibility

- Flag breaking changes to public APIs unless explicitly intended.

- Check request and response models for compatibility.

- Verify status codes and error responses are appropriate.

- Check validation for all externally supplied data.

- Flag changes that silently alter established behaviour.

- Verify pagination, filtering and sorting behaviour where relevant.

### Error handling and observability

- Flag swallowed exceptions and misleading success responses.

- Check that failures provide enough context for diagnosis without exposing sensitive data.

- Verify resources are cleaned up after failures.

- Check that timeouts, cancellation and external-service failures are handled.

- Flag logging that is excessive, absent on important failure paths or privacy-sensitive.

### Tests

- Flag missing tests when the pull request adds or changes meaningful behaviour.

- Verify tests cover the behaviour rather than merely executing code.

- Check important success, failure and boundary cases.

- Flag tests that always pass regardless of implementation correctness.

- Flag removal, weakening or skipping of tests without a justified reason.

- Flag mocks that make tests incapable of detecting realistic regressions.

- Do not demand tests for trivial formatting, comments or documentation-only changes.

### Frontend and accessibility

For user-facing changes:

- Check loading, empty, success and error states.

- Check that forms prevent invalid submissions and display useful errors.

- Flag inaccessible interactive elements.

- Check keyboard navigation and visible focus behaviour.

- Check that controls have meaningful labels.

- Check that changes work reasonably on supported screen sizes.

- Flag important functionality that is available only through colour, hover or pointer input.

### Performance

- Flag obvious unbounded queries, loops or network requests.

- Flag repeated database or API calls that create an N+1 pattern.

- Flag loading significantly more data than required.

- Check that subscriptions, event listeners and resources are disposed correctly.

- Only report performance concerns when there is a plausible meaningful impact.

### Scope and maintainability

- Flag unrelated changes and accidental scope expansion.

- Flag duplicated logic where an established reusable implementation already exists.

- Flag unnecessary new abstractions or dependencies.

- Check that the change follows the existing architecture unless deviation is justified.

- Flag placeholder implementations, hard-coded production data and unfinished code presented as complete.

## Severity guidance

Use the following priorities:

### P0 — Critical

Use P0 only when the change could cause:

- Severe widespread security compromise.

- Irrecoverable data loss.

- A major production outage affecting most users.

- Exposure of highly sensitive credentials or personal information.

### P1 — High

Use P1 when the change could cause:

- Incorrect user-visible behaviour in a normal or realistic scenario.

- An authentication or authorisation bypass.

- Data corruption, duplication or unintended deletion.

- A breaking API or database compatibility issue.

- A meaningful privacy or security vulnerability.

- A serious regression.

- Missing tests for high-risk changed behaviour where the defect could otherwise reach production.

Do not classify cosmetic issues, optional refactors or subjective improvements as P0 or P1.

### P2 — Medium

Use P2 for actionable defects with real but bounded impact:

- Flawed or missing error handling on paths users can plausibly hit.

- Accessibility failures in changed user-facing behaviour.

- Meaningful gaps in test coverage for changed behaviour that is not high-risk.

- Misleading states, labels or messages that cause real confusion.

- Performance problems with a plausible meaningful impact.

P2 findings block approval: they must be fixed or explicitly rebutted before the change is approved.

### P3 — Low

Use P3 for worthwhile but non-blocking improvements: minor robustness hardening, small maintainability issues, optional test additions and documentation gaps. P3 findings must still be reported, but they alone do not prevent approval.

## Final review decision

Approve the pull request when:

- No actionable P0, P1 or P2 defects remain.

- The changed behaviour is adequately tested.

- The implementation matches the stated acceptance criteria.

- Required automated checks pass.

- There are no unresolved security, privacy or data-integrity concerns.

Do not approve merely because the code compiles.

Do not reject a pull request solely because a different implementation style might be preferable.

## Safwa repository-specific review guidance

Safwa is an Arabic vocabulary-learning web app: Next.js (App Router) +
React + TypeScript, Tailwind, Dexie (IndexedDB), pnpm, Vitest and Playwright,
with Python scripts maintaining the vocabulary dataset. `CLAUDE.md` and
`docs/` (especially `docs/IMPLEMENTATION_PHASES.md`,
`docs/PRODUCT_REQUIREMENTS.md`, `docs/ARCHITECTURE.md`) define the intended
behaviour. Work is delivered phase by phase; review each phase against its
documented objective, scope, non-goals and acceptance criteria.

Treat a violation of any of the following repository hard rules as P1 or
higher:

- `data/safwa-mujarrad.original.json` is immutable. Any modification to it is
  a critical defect.
- Quiz-eligibility gating: no quiz target, distractor or study-component
  field may be used for teaching/quizzing unless its `quiz_eligibility`
  boolean is `true`. The presence of a value is not permission to teach it.
- Arabic data handling: Arabic source values must be read programmatically
  from the JSON, never hand-typed or copied from rendered terminal output.
  Comparison uses NFC normalisation, stripping of invisible formatting
  characters (U+200B–U+200F, U+061C, U+FEFF, U+2060) and trimming — nothing
  else. ḥarakāt, shaddah and hamzah-seat differences are meaningful. Display
  strings must never be mutated or "fixed"; normalisation is for comparison
  only.
- The six mujarrad bābs are patterns within Form I, displayed as their Arabic
  māḍī + muḍāriʿ pair (`bab_arabic`), never as Form numbers.
- Content is shipped as immutable versioned releases; learner state lives
  separately (IndexedDB for guests, Postgres for accounts). Flag any mixing
  of editable content copies with learner state.
- The server must never trust client-supplied `is_correct` or `rating` for
  objective questions; correctness derives from the assessment manifest
  server-side.
- Generated artifacts under `public/content/` and `content-server/` must be
  the deterministic output of `pnpm content:build`; hand-edits to them are
  defects.

Verification commands available to the implementer (you must NOT run
anything that writes; reason from source instead): the full gate is
`scripts/quality-gate.ps1` — frozen-lockfile install, Python data
validation, Arabic integrity, content build + artifact-freshness diff, docs
verification, typecheck, ESLint, Prettier check, Vitest, production build,
Playwright E2E.

When acting as the independent phase reviewer you will receive a JSON output
schema. Follow it exactly: `decision` (`APPROVED` / `CHANGES_REQUIRED`),
`summary`, and `findings` with `severity`, `file`, `line`, `title`,
`failure_scenario`, `explanation`, `suggested_fix`. Return
`CHANGES_REQUIRED` whenever any actionable P0/P1/P2 finding exists.
