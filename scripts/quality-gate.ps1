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
      8.  Type checking              pnpm typecheck
      9.  Linting                    pnpm lint
      10. Formatting check           pnpm format:check     (check only, never writes)
      11. Codex runner self-tests    scripts/test-codex-runner.ps1 (sandboxed, mock codex)
      12. Push-guard hook self-tests scripts/test-guard-git-push.ps1
      13. Unit tests                 pnpm test
      14. Production build           pnpm build
      15. Playwright browser         pnpm exec playwright install chromium  (no-op when present)
      16. E2E tests (Playwright)     pnpm test:e2e         (skippable with -SkipE2E, which also skips 15)

    Notes:
      - No check modifies application source files. Step 4 regenerates the
        DERIVED content artifacts (public/content, content-server) exactly as
        CI does; step 5 then fails if the committed artifacts were stale,
        which means the implementer must commit the regenerated output.
      - Nothing in this repository currently requires a database, container
        or environment variable to test locally. When later phases introduce
        Postgres, migration validation must be added here and any checks that
        cannot run locally documented in this header.
      - This script never weakens, skips or deletes tests. -SkipE2E exists
        only for fast inner-loop iteration; the full gate (including E2E)
        must pass before any review or commit.

.PARAMETER SkipE2E
    Skips the Playwright E2E suite. The full gate must still be run before
    review and commit.
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

$steps = @(
    @{ Name = "Dependency validation (frozen lockfile)"; Exe = "pnpm";   Args = @("install", "--frozen-lockfile") },
    @{ Name = "Vocabulary data validation";              Exe = "python"; Args = @("scripts/validate-vocabulary.py") },
    @{ Name = "Arabic integrity verification";           Exe = "python"; Args = @("scripts/arabic-extract.py", "--verify-known") },
    @{ Name = "Content release build";                   Exe = "pnpm";   Args = @("content:build") },
    @{ Name = "Generated artifacts current and deterministic"; Exe = "git"; Args = @("diff", "--exit-code", "--", "public/content", "content-server") },
    @{ Name = "No untracked generated artifacts"; Exe = "git"; Args = @("ls-files", "--others", "--", "public/content", "content-server"); FailOnOutput = $true },
    @{ Name = "Documentation Arabic verification";       Exe = "pnpm";   Args = @("docs:verify") },
    @{ Name = "Type checking";                           Exe = "pnpm";   Args = @("typecheck") },
    @{ Name = "Linting";                                 Exe = "pnpm";   Args = @("lint") },
    @{ Name = "Formatting check";                        Exe = "pnpm";   Args = @("format:check") },
    @{ Name = "Codex runner self-tests";                 Exe = "powershell"; Args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/test-codex-runner.ps1") },
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
    $failed = $false
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
