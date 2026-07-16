<#
.SYNOPSIS
    Self-tests for scripts/run-codex-review.ps1 (the fail-closed review
    decision boundary).

.DESCRIPTION
    Builds a disposable sandbox: a temporary git repository containing the
    review prompt and schema, plus a mock `codex` executable (a .cmd shim
    that a scenario-specific environment variable controls). Runs the REAL
    run-codex-review.ps1 against the sandbox and asserts the exit code of
    every decision branch:

      1.  APPROVED, no findings                       -> exit 0
      2.  APPROVED with a P1 finding (inconsistent)   -> exit 1
      3.  CHANGES_REQUIRED with a P2 finding          -> exit 2
      4.  CHANGES_REQUIRED with only P3 (inconsistent)-> exit 1
      5.  codex exits non-zero                        -> exit 1 (never approval)
      6.  codex emits invalid JSON                    -> exit 1
      7.  codex creates a new file                    -> exit 1
      8.  codex changes an already-dirty tracked file -> exit 1
      9.  codex changes an existing untracked file    -> exit 1
      10. base ref does not exist                     -> exit 1

    The sandbox repo path contains a space, so every scenario also proves
    quoted-path handling in the runner and the mock.

    Read-only with respect to the repository: everything happens in a temp
    directory that is removed afterwards. Exits 0 when all scenarios pass,
    1 otherwise.
#>
$ErrorActionPreference = "Stop"

$repoRoot = & git rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: not in a git repository." -ForegroundColor Red; exit 1 }
$repoRoot = $repoRoot.Trim()
$runnerScript = Join-Path $repoRoot "scripts\run-codex-review.ps1"

$sandbox = Join-Path $env:TEMP ("codex-runner-tests-" + [System.Guid]::NewGuid().ToString("N").Substring(0, 8))
$binDir = Join-Path $sandbox "bin"
# The repo path deliberately contains a space: every scenario then proves the
# runner and mock survive quoted paths with embedded spaces.
$testRepo = Join-Path $sandbox "repo with space"
$responseDir = Join-Path $sandbox "responses"

$failures = 0
$total = 0

try {
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    New-Item -ItemType Directory -Path $testRepo -Force | Out-Null
    New-Item -ItemType Directory -Path $responseDir -Force | Out-Null

    # --- Mock codex: .cmd shim (so $LASTEXITCODE is set) + PS logic ----------
    # The shim extracts the -o argument with cmd shift-parsing while the
    # arguments are still individually quoted (%~2 strips quotes but keeps
    # embedded spaces), then hands it to PowerShell via MOCK_OUT. Passing raw
    # args on the powershell -File command line would make the parameter
    # binder try to bind dash-prefixed codex flags (-o, --ephemeral, bare -).
    $shimLines = @(
        "@echo off"
        "rem Capture the shim's directory BEFORE the loop: shift also shifts %0,"
        "rem which would silently repoint %~dp0 at the current directory."
        "set `"SCRIPT_DIR=%~dp0`""
        "set `"MOCK_OUT=`""
        ":parse"
        "if `"%~1`"==`"`" goto run"
        "if `"%~1`"==`"-o`" set `"MOCK_OUT=%~2`""
        "shift"
        "goto parse"
        ":run"
        "powershell -NoProfile -ExecutionPolicy Bypass -File `"%SCRIPT_DIR%codex-mock.ps1`""
        "exit /b %ERRORLEVEL%"
    ) -join "`r`n"
    [IO.File]::WriteAllText((Join-Path $binDir "codex.cmd"), $shimLines, [Text.Encoding]::ASCII)

    $mock = @(
        '$null = [Console]::In.ReadToEnd()'                                     # consume stdin like real codex
        'if ($env:MOCK_CODEX_MODE -eq "mutate") { Set-Content -Path $env:MOCK_MUTATE_TARGET -Value "mutated" }'
        'if ($env:MOCK_CODEX_MODE -eq "mutate-tracked") { Add-Content -Path $env:MOCK_MUTATE_TARGET -Value "sneaky edit" }'
        'if ($env:MOCK_CODEX_MODE -eq "mutate-untracked") { Set-Content -Path $env:MOCK_MUTATE_TARGET -Value "different bytes" }'
        'if ($env:MOCK_CODEX_MODE -eq "exitfail") { exit 3 }'
        'if (-not [string]::IsNullOrWhiteSpace($env:MOCK_OUT)) { Copy-Item -Path $env:MOCK_CODEX_RESPONSE -Destination $env:MOCK_OUT -Force }'
        'exit 0'
    ) -join "`r`n"
    [IO.File]::WriteAllText((Join-Path $binDir "codex-mock.ps1"), $mock, [Text.Encoding]::ASCII)

    # --- Canned responses ------------------------------------------------------
    # Placeholder must not collide case-insensitively with the "severity" key.
    $finding = '{"severity":"@@SEV@@","file":"a.ts","line":1,"title":"t","failure_scenario":"s","explanation":"e","suggested_fix":"f"}'
    $responses = @{
        "approved_clean" = '{"decision":"APPROVED","summary":"ok","findings":[]}'
        "approved_bad"   = '{"decision":"APPROVED","summary":"bad","findings":[' + $finding.Replace("@@SEV@@", "P1") + ']}'
        "changes_p2"     = '{"decision":"CHANGES_REQUIRED","summary":"p2","findings":[' + $finding.Replace("@@SEV@@", "P2") + ']}'
        "changes_p3only" = '{"decision":"CHANGES_REQUIRED","summary":"p3","findings":[' + $finding.Replace("@@SEV@@", "P3") + ']}'
        "badjson"        = '{this is not json'
    }
    foreach ($name in $responses.Keys) {
        [IO.File]::WriteAllText((Join-Path $responseDir "$name.json"), $responses[$name], (New-Object Text.UTF8Encoding $false))
    }

    # --- Sandbox git repository with the review prompt and schema -------------
    Push-Location $testRepo
    & git init --quiet | Out-Null
    & git config user.email "test@example.invalid"
    & git config user.name "Codex Runner Test"
    & git config core.autocrlf false
    # Isolate from machine-level git settings that would break the synthetic
    # commit: signing (no key in this context) and global hook paths.
    & git config commit.gpgsign false
    & git config tag.gpgsign false
    $noHooks = Join-Path $sandbox "no-hooks"
    New-Item -ItemType Directory -Path $noHooks -Force | Out-Null
    & git config core.hooksPath $noHooks
    New-Item -ItemType Directory -Path (Join-Path $testRepo ".claude\review") -Force | Out-Null
    Copy-Item (Join-Path $repoRoot ".claude\review\codex-review-prompt.md") (Join-Path $testRepo ".claude\review\codex-review-prompt.md")
    Copy-Item (Join-Path $repoRoot ".claude\review\codex-review.schema.json") (Join-Path $testRepo ".claude\review\codex-review.schema.json")
    Set-Content -Path (Join-Path $testRepo "README.md") -Value "sandbox"
    # Mirror the production .gitignore rule: the runner writes latest.json
    # into the repo, which must not trip its own tree-mutation guard.
    Set-Content -Path (Join-Path $testRepo ".gitignore") -Value ".claude/review/results/"
    & git add -A | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Sandbox setup failed: git add exited with $LASTEXITCODE" }
    & git commit --quiet -m "init" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Sandbox setup failed: git commit exited with $LASTEXITCODE" }
    Pop-Location

    # --- Scenario runner ---------------------------------------------------------
    function Invoke-Scenario {
        param(
            [string]$Name,
            [string]$Mode,          # ok | exitfail | mutate | mutate-tracked | mutate-untracked
            [string]$Response,      # key into $responses (ignored for exitfail)
            [string]$BaseRef,
            [int]$ExpectedExit,
            [string]$MutateTarget = "mutated.txt",
            [scriptblock]$Setup,
            [scriptblock]$Cleanup
        )
        $script:total++
        $env:MOCK_CODEX_MODE = $Mode
        $env:MOCK_CODEX_RESPONSE = Join-Path $responseDir "$Response.json"
        $env:MOCK_MUTATE_TARGET = Join-Path $testRepo $MutateTarget
        $env:PATH = "$binDir;$env:PATH"
        try {
            Push-Location $testRepo
            if ($Setup) { & $Setup }
            # cmd /c owns the output redirection: redirecting the child's
            # stderr in PowerShell 5.1 would raise NativeCommandError under
            # ErrorActionPreference=Stop. cmd propagates the child exit code.
            $logPath = Join-Path $sandbox "last-run.log"
            & cmd /c "powershell -NoProfile -ExecutionPolicy Bypass -File `"$runnerScript`" -BaseBranch `"$BaseRef`" >`"$logPath`" 2>&1"
            $actual = $LASTEXITCODE
        } finally {
            if ($Cleanup) { & $Cleanup }
            Pop-Location
            $env:PATH = ($env:PATH).Substring($binDir.Length + 1)
        }
        if ($actual -eq $ExpectedExit) {
            Write-Host ("  PASS  {0} (exit {1})" -f $Name, $actual) -ForegroundColor Green
        } else {
            Write-Host ("  FAIL  {0}: expected exit {1}, got {2}" -f $Name, $ExpectedExit, $actual) -ForegroundColor Red
            if (Test-Path $logPath) {
                Get-Content $logPath | Select-Object -Last 10 | ForEach-Object { Write-Host ("        | " + $_) -ForegroundColor DarkGray }
            }
            $script:failures++
        }
    }

    Write-Host "Codex runner self-tests (sandbox: $sandbox)" -ForegroundColor Cyan
    Invoke-Scenario -Name "APPROVED with no findings -> 0"                 -Mode "ok"       -Response "approved_clean" -BaseRef "HEAD" -ExpectedExit 0
    Invoke-Scenario -Name "APPROVED with P1 finding is inconsistent -> 1"  -Mode "ok"       -Response "approved_bad"   -BaseRef "HEAD" -ExpectedExit 1
    Invoke-Scenario -Name "CHANGES_REQUIRED with P2 -> 2"                  -Mode "ok"       -Response "changes_p2"     -BaseRef "HEAD" -ExpectedExit 2
    Invoke-Scenario -Name "CHANGES_REQUIRED with only P3 is inconsistent -> 1" -Mode "ok"   -Response "changes_p3only" -BaseRef "HEAD" -ExpectedExit 1
    Invoke-Scenario -Name "codex non-zero exit is never approval -> 1"     -Mode "exitfail" -Response "approved_clean" -BaseRef "HEAD" -ExpectedExit 1
    Invoke-Scenario -Name "invalid JSON output -> 1"                       -Mode "ok"       -Response "badjson"        -BaseRef "HEAD" -ExpectedExit 1
    Invoke-Scenario -Name "new-file mutation by codex -> 1"                -Mode "mutate"   -Response "approved_clean" -BaseRef "HEAD" -ExpectedExit 1 `
        -Cleanup { if (Test-Path "mutated.txt") { Remove-Item "mutated.txt" -Force } }
    Invoke-Scenario -Name "content change to an ALREADY-dirty tracked file -> 1" -Mode "mutate-tracked" -Response "approved_clean" -BaseRef "HEAD" -ExpectedExit 1 `
        -MutateTarget "README.md" `
        -Setup   { Add-Content -Path "README.md" -Value "pre-existing uncommitted change" } `
        -Cleanup { & git checkout -- README.md }
    Invoke-Scenario -Name "content change to an EXISTING untracked file -> 1" -Mode "mutate-untracked" -Response "approved_clean" -BaseRef "HEAD" -ExpectedExit 1 `
        -MutateTarget "notes.txt" `
        -Setup   { Set-Content -Path "notes.txt" -Value "original untracked content" } `
        -Cleanup { if (Test-Path "notes.txt") { Remove-Item "notes.txt" -Force } }
    Invoke-Scenario -Name "missing base ref -> 1"                          -Mode "ok"       -Response "approved_clean" -BaseRef "refs/heads/does-not-exist" -ExpectedExit 1
} finally {
    Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item Env:\MOCK_CODEX_MODE, Env:\MOCK_CODEX_RESPONSE, Env:\MOCK_MUTATE_TARGET -ErrorAction SilentlyContinue
}

if ($failures -gt 0) {
    Write-Host "CODEX RUNNER SELF-TESTS FAILED: $failures of $total scenario(s)" -ForegroundColor Red
    exit 1
}
Write-Host "CODEX RUNNER SELF-TESTS PASSED ($total/$total scenarios)" -ForegroundColor Green
exit 0
