---
name: phase-loop
description: >-
  Autonomous phase implementation and review loop for Safwa: implement a
  phase on a new branch, pass the quality gate, iterate through the
  read-only Claude reviewer until it approves, then push and open a DRAFT
  pull request. Never merges, never deploys.
disable-model-invocation: true
argument-hint: <phase requirements — e.g. "Phase 5 — guest identity & local persistence" plus any extra constraints>
allowed-tools: Read, Grep, Glob, Edit, Write, Agent, TaskCreate, TaskUpdate, TaskList, Bash(git status:*), Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git rev-parse:*), Bash(git merge-base:*), Bash(git ls-files:*), Bash(git fetch origin:*), Bash(git switch -c phase/*), Bash(git switch phase/*), Bash(git switch main), Bash(git add:*), Bash(git commit:*), Bash(git push -u origin phase/*), Bash(git push origin phase/*), Bash(pnpm typecheck:*), Bash(pnpm lint:*), Bash(pnpm format:check:*), Bash(pnpm test:*), Bash(pnpm test:e2e:*), Bash(pnpm build:*), Bash(pnpm content:build:*), Bash(pnpm docs:verify:*), Bash(pnpm install --frozen-lockfile:*), Bash(pnpm exec playwright install chromium), Bash(python scripts/validate-vocabulary.py:*), Bash(python scripts/arabic-extract.py --verify-known:*), Bash(powershell -ExecutionPolicy Bypass -File scripts/quality-gate.ps1:*), Bash(powershell -ExecutionPolicy Bypass -File scripts/workspace-fingerprint.ps1), Bash(gh pr create:*), PowerShell(git status:*), PowerShell(git diff:*), PowerShell(git log:*), PowerShell(git show:*), PowerShell(git rev-parse:*), PowerShell(git merge-base:*), PowerShell(git ls-files:*), PowerShell(git fetch origin:*), PowerShell(git switch -c phase/*), PowerShell(git switch phase/*), PowerShell(git switch main), PowerShell(git add:*), PowerShell(git commit:*), PowerShell(git push -u origin phase/*), PowerShell(git push origin phase/*), PowerShell(pnpm typecheck:*), PowerShell(pnpm lint:*), PowerShell(pnpm format:check:*), PowerShell(pnpm test:*), PowerShell(pnpm test:e2e:*), PowerShell(pnpm build:*), PowerShell(pnpm content:build:*), PowerShell(pnpm docs:verify:*), PowerShell(pnpm install --frozen-lockfile:*), PowerShell(pnpm exec playwright install chromium), PowerShell(python scripts/validate-vocabulary.py:*), PowerShell(python scripts/arabic-extract.py --verify-known:*), PowerShell(powershell -ExecutionPolicy Bypass -File scripts/quality-gate.ps1:*), PowerShell(powershell -ExecutionPolicy Bypass -File scripts/workspace-fingerprint.ps1), PowerShell(gh pr create:*)
---

# /phase-loop — autonomous phase implementation with review

The arguments to this skill are the phase requirements. Implement exactly that
phase following this workflow. Follow every rule in `CLAUDE.md` — especially
the hard rules — throughout.

Absolute prohibitions for the entire run: no force pushes, no `git reset
--hard`, no `git clean`, no branch deletion, no merging any pull request, no
deployment, no weakening/skipping/deleting tests to make checks pass.

## 1. Phase preparation

1. Treat the skill arguments as the phase requirements. Read the matching
   phase section in `docs/phases/IMPLEMENTATION_PHASES.md` (objective, scope,
   non-goals, prerequisites, expected files, testing checkpoint, acceptance
   criteria, risks) and merge it with any extra constraints in the arguments.
2. Verify the current branch is the base branch (`main`) or an appropriate
   existing branch for this phase. If it is some other branch, stop and
   report rather than building on unrelated work.
3. Run `git status --porcelain`. If there are uncommitted changes unrelated
   to this phase that could be overwritten or accidentally committed, STOP
   and report this as a **vital escalation** — do not stash, reset or discard
   anything.
4. `git fetch origin` to get the latest base branch. From here on,
   `origin/main` is THE base ref for everything — branch creation, the
   review and the final diff inspection — so a stale local `main` can
   never leak unrelated upstream changes into a review. Only the pull
   request base (step 37) uses the branch name `main`.
5. Create the branch as `phase/<number>-<short-kebab-description>` (matching
   the existing convention, e.g. `phase/5-guest-identity`), via
   `git switch -c phase/<...> origin/main`.
6. Before writing any code, record the measurable acceptance criteria for the
   phase (from the phase doc plus the arguments) in your task list AND write
   the complete phase requirements (objective, scope, non-goals, acceptance
   criteria, extra user constraints) to
   `.claude/review/results/phase-requirements.md` (gitignored). Every
   criterion must be verifiable; this exact file is given to the reviewer so
   it judges against the same criteria as the implementer.
7. Do not ask the user questions unless a genuinely vital product decision is
   required (see escalation triggers below). Prefer the documented behaviour
   in `docs/PRODUCT_REQUIREMENTS.md` and `docs/ARCHITECTURE.md`.

## 2. Implementation

8. Inspect the relevant existing code, modules and tests before editing.
9. Form a concise internal implementation plan (no need to surface it for
   approval).
10. Implement ONLY the requested phase. Respect the phase's stated non-goals.
11. Follow the existing architecture, module boundaries and conventions
    (`docs/ARCHITECTURE.md`, existing code style).
12. Add or update meaningful tests per `docs/TEST_STRATEGY.md` and the
    phase's testing checkpoint — tests that would fail if the behaviour were
    wrong.
13. No placeholders, fake implementations, TODO-stubs or commented-out
    unfinished work presented as complete (placeholders explicitly required
    by the phase doc, e.g. "bookmark placeholder", are part of the spec and
    fine).
14. Never change the requirements to make implementation easier. If a
    requirement seems wrong or infeasible, that is an escalation, not a
    silent redefinition.

## 3. Quality verification

15. Run the full quality gate:
    `powershell -ExecutionPolicy Bypass -File scripts/quality-gate.ps1`
    If the phase changed vocabulary content or the content pipeline, first
    stage ONLY the regenerated artifacts
    (`git add public/content content-server`). Staging is not committing —
    the gate's artifact checks compare against the index, and the staged
    output becomes part of the single phase commit only after review
    approval (step 35).
16. Fix deterministic failures and rerun until it passes.
17. Never delete, weaken, skip or hollow out a test to make the gate pass.
18. Where practical, verify important user-facing behaviour directly (e.g.
    drive the affected flow) rather than relying solely on tests.

## 4. Claude review loop

19. Capture the workspace fingerprint BEFORE the review:
    `powershell -ExecutionPolicy Bypass -File scripts/workspace-fingerprint.ps1`
    Then invoke the `phase-code-reviewer` subagent in the FOREGROUND (Agent
    tool, `subagent_type: "phase-code-reviewer"`, `run_in_background: false`).
    Subagent permission modes are not guaranteed to survive every parent
    permission mode, so the reviewer's read-onlyness is verified by
    detection, not assumed.
20. Give it: the base ref (`origin/main`) and the verbatim content of
    `.claude/review/results/phase-requirements.md`.
21. Wait for its complete response and read the decision line. Re-run the
    fingerprint command and compare: if the digest changed, the review is
    VOID — investigate what changed, restore/fix as needed, rerun the
    quality gate and rerun the review. Never accept an approval whose
    fingerprints do not match.
22. Fix ALL valid P0, P1 and P2 findings. If a finding is demonstrably
    incorrect, record a concise technical rationale (keep it for the PR
    description) instead of changing code.
23. After any fix: rerun the full quality gate.
24. Then rerun the Claude reviewer with the same inputs.
25. Repeat until the reviewer returns `APPROVED`.
26. Any code change invalidates the prior approval — there are no stale
    approvals.

## 5. Loop limits and escalation

27. Allow at most FIVE correction cycles (a cycle = one reviewer-driven round
    of fixes plus reruns).
28. STOP and produce a **vital escalation report** (what was attempted, the
    unresolved findings, your analysis, options for the user) when any of
    these occur:
    - five legitimate correction cycles have failed to reach approval;
    - authentication, authorisation, payments, privacy or destructive data
      behaviour requires a product decision;
    - a database migration could destroy or irreversibly transform existing
      data;
    - a new paid service or major architectural dependency is required;
    - required credentials or external services are unavailable;
    - a model, authentication or rate-limit error prevents the review from
      running.
29. When escalating: do NOT create a pull request. Leave the branch and
    working tree intact for the user.

## 6. Finalisation

30. Inspect the final diff (`git diff origin/main...HEAD` plus `git status`) for
    accidental or unrelated changes; remove anything out of scope (which
    invalidates approval — loop again).
31. Confirm every recorded acceptance criterion is met.
32. Run the complete quality gate one final time.
33. Run one final Claude review.
34. Make NO code changes after this final approval.
35. Stage the COMPLETE reviewed change set explicitly (`git add` every
    reviewed path — source, tests, docs and any previously staged generated
    artifacts; staging unchanged reviewed bytes does not invalidate
    approval), then commit with a meaningful message following the repo
    convention (`Phase <n>: <summary>`). Immediately verify nothing was
    left behind: `git status --porcelain` must be empty, and inspect
    `git show --stat HEAD` to confirm the commit contains the full reviewed
    union. A non-empty status or missing files means the commit is partial —
    fix it before pushing.
36. Push the branch normally: `git push -u origin phase/<...>` — never force.
37. Create a DRAFT pull request with `gh pr create --draft --base main`, with
    a body containing ALL of:
    - Phase objective
    - Acceptance criteria (checked off)
    - Implementation summary
    - Files/areas changed
    - Tests and checks run (quality-gate evidence)
    - Claude review result and number of review cycles
    - Rebutted findings with rationales (if any)
    - Known limitations
    - Manual review guidance (what the human should look at most carefully)
38. NEVER merge the pull request. NEVER deploy.
39. Finish by giving the user: the draft PR link, a concise implementation
    summary, the testing evidence, and anything needing particular human
    attention.
