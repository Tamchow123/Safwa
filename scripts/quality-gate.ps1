<#
.SYNOPSIS
    Deterministic quality gate for the Safwa repository.

.DESCRIPTION
    Runs every check that CI (.github/workflows/ci.yml) runs, in the same
    order, non-interactively, and stops at the first required failure.

    Checks:
      1.  Dependency validation      pnpm install --frozen-lockfile
      2.  Vocabulary data validation python scripts/validate-vocabulary.py
      3.  Arabic integrity           python scripts/arabic-extract.py --verify-known
      4.  Content release build      pnpm content:build   (regenerates artifacts deterministically)
      5.  Generated artifacts fresh  git diff --exit-code -- public/content content-server
      6.  No untracked artifacts     git ls-files --others -- public/content content-server
                                     (no --exclude-standard: even ignored files may not hide there)
      7.  Documentation Arabic       pnpm docs:verify
      8.  Disposable Postgres reachable (concise diagnostic if not; see below)
      9.  Migration chain            pnpm db:migrate
      10. Content version registration pnpm db:register-content
      11. Database integration tests  pnpm test:integration  (constraints, content
                                      registration, Better Auth, manifest loader —
                                      one Vitest config covers all of these)
      12. Type checking              pnpm typecheck
      13. Linting                    pnpm lint
      14. Formatting check           pnpm format:check     (check only, never writes)
      15. Push-guard hook self-tests scripts/test-guard-git-push.ps1
      16. Unit tests                 pnpm test
      17. Production build           pnpm build
      18. Playwright browser         pnpm exec playwright install chromium  (no-op when present)
      19. E2E tests (Playwright)     pnpm test:e2e         (skippable with -SkipE2E, which also skips 18)

    Notes:
      - No check modifies application source files. Step 4 regenerates the
        DERIVED content artifacts (public/content, content-server) exactly as
        CI does; step 5 then fails if the committed artifacts were stale,
        which means the implementer must commit the regenerated output.
      - Steps 8-11 are the only ones that touch a database. They require a
        reachable local Postgres with a `safwa_test` database already
        provisioned (`docker compose up -d db` — see compose.yaml and
        docker/init-test-db.sql) and run with NODE_ENV=test against a
        DATABASE_URL rewritten to point at `safwa_test` specifically,
        derived from .env.local's own DATABASE_URL (only the database name
        is swapped — host/port/credentials are reused). This mirrors the
        exact env shape .github/workflows/ci.yml's "quality" job uses.
        db/reset-test-database.ts's own hard safety gate (name must match
        `/^safwa_test(_\w+)?$/` AND NODE_ENV=test) refuses to touch
        anything else — this script does not duplicate that check, only
        surfaces its failure clearly if it fires.
      - Every OTHER step (typecheck, lint, unit tests, build, E2E) never
        requires a database — E2E provisions and tears down its own
        disposable state per e2e/global-setup.ts, independent of this
        script.
      - This script never weakens, skips or deletes tests. -SkipE2E exists
        only for fast inner-loop iteration; the full gate (including E2E)
        must pass before any review or commit.

.PARAMETER SkipE2E
    Skips the Playwright E2E suite. The full gate must still be run before
    review and commit.

.NOTES
    Always invoke as `powershell -File scripts/quality-gate.ps1` (its own
    process). Do not dot-source this script into an interactive session —
    steps 8-11's temporary NODE_ENV=test/DATABASE_URL overrides are
    restored in a `finally` block scoped to this script's own execution,
    which only fully protects an interactive shell's own environment when
    the script runs as a separate process.
#>
[CmdletBinding()]
param(
    [switch]$SkipE2E
)

$ErrorActionPreference = "Stop"

$repoRoot = & git rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($repoRoot)) {
    Write-Host "ERROR: not inside a Git repository." -ForegroundColor Red
    exit 1
}
Set-Location $repoRoot.Trim()

# Run with CI semantics. Critically, playwright.config.ts sets
# reuseExistingServer: !process.env.CI - without CI set, the E2E step could
# silently test a stale dev server from another checkout instead of the
# current working tree. CI=1 forces a fresh webServer (and CI retry/forbidOnly
# behaviour), so a green gate always describes THIS tree.
$env:CI = "1"

# Derives the disposable-test-database DATABASE_URL for steps 8-11: reads
# .env.local's own DATABASE_URL (the same one `pnpm dev` uses, pointing at
# `safwa_dev`) and swaps ONLY the database name to `safwa_test` — host,
# port and credentials are reused as-is. This script is plain PowerShell,
# so unlike the Node/Next tooling it invokes, it must parse .env.local
# itself; nothing here ever writes to that file.
function Get-TestDatabaseUrl {
    $envFile = Join-Path $repoRoot.Trim() ".env.local"
    if (-not (Test-Path $envFile)) {
        throw ".env.local not found. Copy .env.example to .env.local and set DATABASE_URL before running the quality gate (see docs/DEPLOYMENT.md)."
    }
    $line = Get-Content $envFile | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } | Select-Object -Last 1
    if (-not $line) {
        throw "DATABASE_URL is not set in .env.local."
    }
    $value = ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
    try {
        $uri = [System.Uri]$value
    } catch {
        throw "DATABASE_URL in .env.local is not a valid URL."
    }
    $userInfo = if ($uri.UserInfo) { "$($uri.UserInfo)@" } else { "" }
    return "$($uri.Scheme)://${userInfo}$($uri.Host):$($uri.Port)/safwa_test"
}

# A password-redacted display form of the same URL, built from the parsed
# [System.Uri] object (not a regex over the raw string) so it can never
# under-redact a password containing `:`/`@` — those are exactly the
# characters a regex-based approach would misparse.
function Get-RedactedDatabaseUrl([string]$url) {
    $uri = [System.Uri]$url
    $userPart = if ($uri.UserInfo) { "$($uri.UserInfo.Split(':')[0]):***@" } else { "" }
    return "$($uri.Scheme)://${userPart}$($uri.Host):$($uri.Port)$($uri.AbsolutePath)"
}

$testDatabaseUrl = Get-TestDatabaseUrl
$testDatabaseUrlRedacted = Get-RedactedDatabaseUrl $testDatabaseUrl
$dbStepEnv = @{ NODE_ENV = "test"; DATABASE_URL = $testDatabaseUrl }
$postgresCheckEnv = @{ NODE_ENV = "test"; DATABASE_URL = $testDatabaseUrl; DATABASE_URL_DISPLAY = $testDatabaseUrlRedacted }

$steps = @(
    @{ Name = "Dependency validation (frozen lockfile)"; Exe = "pnpm";   Args = @("install", "--frozen-lockfile") },
    @{ Name = "Vocabulary data validation";              Exe = "python"; Args = @("scripts/validate-vocabulary.py") },
    @{ Name = "Arabic integrity verification";           Exe = "python"; Args = @("scripts/arabic-extract.py", "--verify-known") },
    @{ Name = "Content release build";                   Exe = "pnpm";   Args = @("content:build") },
    @{ Name = "Generated artifacts current and deterministic"; Exe = "git"; Args = @("diff", "--exit-code", "--", "public/content", "content-server") },
    @{ Name = "No untracked generated artifacts"; Exe = "git"; Args = @("ls-files", "--others", "--", "public/content", "content-server"); FailOnOutput = $true },
    @{ Name = "Documentation Arabic verification";       Exe = "pnpm";   Args = @("docs:verify") },
    @{ Name = "Disposable Postgres reachable (safwa_test)"; Exe = "node"; Args = @(
        "-e",
        "const {Client}=require('pg');const c=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000});c.connect().then(()=>c.end()).then(()=>process.exit(0)).catch((e)=>{console.error('Cannot reach disposable test Postgres at '+process.env.DATABASE_URL_DISPLAY+': '+e.message);console.error('Start it with: docker compose up -d db  (see compose.yaml, docker/init-test-db.sql)');process.exit(1);});"
      ); Env = $postgresCheckEnv },
    @{ Name = "Apply full migration chain";              Exe = "pnpm";   Args = @("db:migrate"); Env = $dbStepEnv },
    @{ Name = "Register content versions";               Exe = "pnpm";   Args = @("db:register-content"); Env = $dbStepEnv },
    @{ Name = "Database integration tests (constraints, content registration, auth, manifest loader)"; Exe = "pnpm"; Args = @("test:integration"); Env = $dbStepEnv },
    @{ Name = "Type checking";                           Exe = "pnpm";   Args = @("typecheck") },
    @{ Name = "Linting";                                 Exe = "pnpm";   Args = @("lint") },
    @{ Name = "Formatting check";                        Exe = "pnpm";   Args = @("format:check") },
    @{ Name = "Push-guard hook self-tests";              Exe = "powershell"; Args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/test-guard-git-push.ps1") },
    @{ Name = "Unit tests (Vitest)";                     Exe = "pnpm";   Args = @("test") },
    @{ Name = "Production build";                        Exe = "pnpm";   Args = @("build") }
)

if (-not $SkipE2E) {
    $steps += @{ Name = "Playwright Chromium available (installs if missing)"; Exe = "pnpm"; Args = @("exec", "playwright", "install", "chromium") }
    $steps += @{ Name = "E2E tests (Playwright, desktop + mobile Chromium)"; Exe = "pnpm"; Args = @("test:e2e") }
} else {
    Write-Host "NOTE: -SkipE2E supplied. The FULL gate (including E2E) must pass before review and commit." -ForegroundColor Yellow
}

$total = $steps.Count
$index = 0
$sw = [System.Diagnostics.Stopwatch]::StartNew()

foreach ($step in $steps) {
    $index++
    Write-Host ""
    Write-Host "[$index/$total] $($step.Name)" -ForegroundColor Cyan
    Write-Host ("-" * 60)

    # Real splatting (@var) so arguments flatten correctly even when the
    # executable is a PowerShell shim (pnpm.ps1) rather than a native exe.
    $stepArgs = @($step.Args)

    # Steps 8-11 (Env present) run against the disposable test database;
    # every other step is unaffected — set only for this step's duration,
    # then restored (in `finally`, so a thrown exception mid-step can never
    # leak NODE_ENV=test/DATABASE_URL into a later, unrelated step).
    $previousEnv = @{}
    $failed = $false
    try {
        if ($step.Env) {
            foreach ($key in $step.Env.Keys) {
                $previousEnv[$key] = [System.Environment]::GetEnvironmentVariable($key)
                [System.Environment]::SetEnvironmentVariable($key, $step.Env[$key])
            }
        }

        if ($step.FailOnOutput) {
            # Steps like `git ls-files --others` exit 0 even when they find
            # violations; any output at all means the check failed.
            $output = & $step.Exe @stepArgs
            if ($LASTEXITCODE -ne 0) { $failed = $true }
            if (-not [string]::IsNullOrWhiteSpace(($output -join "`n"))) {
                $output | Write-Host
                Write-Host "Untracked files found where only tracked generated artifacts are allowed. Stage the regenerated output (git add public/content content-server) and rerun the gate; staging is not committing." -ForegroundColor Yellow
                $failed = $true
            }
        } else {
            & $step.Exe @stepArgs
            if ($LASTEXITCODE -ne 0) { $failed = $true }
        }
    } finally {
        if ($step.Env) {
            foreach ($key in $previousEnv.Keys) {
                [System.Environment]::SetEnvironmentVariable($key, $previousEnv[$key])
            }
        }
    }

    if ($failed) {
        Write-Host ""
        Write-Host "QUALITY GATE FAILED at step ${index}: $($step.Name)" -ForegroundColor Red
        Write-Host "Command: $($step.Exe) $($step.Args -join ' ')" -ForegroundColor Red
        if ($step.Name -like "Generated artifacts*") {
            Write-Host "The generated artifacts are stale. Review the diff under public/content and content-server, stage the regenerated output (git add public/content content-server) and rerun the gate; it becomes part of the phase commit after review approval." -ForegroundColor Yellow
        }
        exit 1
    }
}

$sw.Stop()
Write-Host ""
Write-Host "QUALITY GATE PASSED ($total/$total checks in $([int]$sw.Elapsed.TotalSeconds)s)" -ForegroundColor Green
exit 0
