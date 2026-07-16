<#
.SYNOPSIS
    Table-driven tests for scripts/guard-git-push.ps1 (the PreToolUse hook
    that blocks destructive git/gh operations).

.DESCRIPTION
    Feeds representative hook payloads to the real guard script over stdin
    and asserts the exit code: 0 (allow) or 2 (block). Covers standalone and
    clustered short options, long options, forced/deleting refspecs, compound
    commands, safe forms, and malformed payloads (which must fail open).
    Exits 0 when all cases pass, 1 otherwise.
#>
$ErrorActionPreference = "Stop"

$repoRoot = & git rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: not in a git repository." -ForegroundColor Red; exit 1 }
$guard = Join-Path $repoRoot.Trim() "scripts\guard-git-push.ps1"

$cases = @(
    # Safe forms must pass.
    @{ Cmd = "git push -u origin phase/5-guest-identity"; Expect = 0; Name = "normal push (-u)" },
    @{ Cmd = "git push origin phase/5"; Expect = 0; Name = "plain push" },
    @{ Cmd = "git status; git diff origin/main...HEAD"; Expect = 0; Name = "read-only compound" },
    @{ Cmd = "git branch -m old new"; Expect = 0; Name = "branch rename" },
    @{ Cmd = "git fetch origin"; Expect = 0; Name = "fetch" },
    @{ Cmd = "pnpm test"; Expect = 0; Name = "non-git command" },
    # Force pushes: long, standalone short, clustered short, with-lease/if-includes.
    @{ Cmd = "git push --force origin phase/5"; Expect = 2; Name = "--force (leading)" },
    @{ Cmd = "git push origin phase/5 --force"; Expect = 2; Name = "--force (trailing)" },
    @{ Cmd = "git push -u origin phase/5 --force-with-lease"; Expect = 2; Name = "--force-with-lease (trailing)" },
    @{ Cmd = "git push origin phase/5 --force-if-includes"; Expect = 2; Name = "--force-if-includes" },
    @{ Cmd = "git push origin phase/5 -f"; Expect = 2; Name = "-f standalone" },
    @{ Cmd = "git push -fu origin phase/5"; Expect = 2; Name = "-fu clustered" },
    @{ Cmd = "git push -uf origin phase/5"; Expect = 2; Name = "-uf clustered" },
    # Deletions: long, short, clustered, refspecs, mirror.
    @{ Cmd = "git push origin --delete phase/5"; Expect = 2; Name = "push --delete" },
    @{ Cmd = "git push -d origin phase/5"; Expect = 2; Name = "push -d" },
    @{ Cmd = "git push origin +phase/5"; Expect = 2; Name = "forced refspec +ref" },
    @{ Cmd = "git push origin :phase/5"; Expect = 2; Name = "deleting refspec :ref" },
    @{ Cmd = "git push -u origin phase/5-guest-identity:main"; Expect = 2; Name = "refspec to main blocked" },
    @{ Cmd = "git push origin HEAD:main"; Expect = 2; Name = "HEAD:main blocked" },
    @{ Cmd = "git push origin HEAD:refs/heads/main"; Expect = 2; Name = "HEAD:refs/heads/main blocked" },
    @{ Cmd = "git push origin phase/5:phase/5"; Expect = 0; Name = "same-phase refspec allowed" },
    @{ Cmd = "git push origin HEAD:phase/5"; Expect = 0; Name = "HEAD:phase refspec allowed" },
    @{ Cmd = "git push --mirror origin"; Expect = 2; Name = "push --mirror" },
    # Multi-ref and bulk pushes: every bare ref after the remote must be phase/*.
    @{ Cmd = "git push origin phase/5 main"; Expect = 2; Name = "extra bare main ref blocked" },
    @{ Cmd = "git push origin main"; Expect = 2; Name = "bare main ref blocked" },
    @{ Cmd = "git push origin HEAD"; Expect = 2; Name = "bare HEAD blocked (use HEAD:phase/N)" },
    @{ Cmd = "git push --all origin"; Expect = 2; Name = "push --all blocked" },
    @{ Cmd = "git push --tags origin"; Expect = 2; Name = "push --tags blocked" },
    @{ Cmd = "git push origin phase/5 phase/6"; Expect = 0; Name = "multiple phase refs allowed" },
    @{ Cmd = "git push --set-upstream origin phase/5"; Expect = 0; Name = "--set-upstream allowed" },
    # git switch: force/discard variants are blocked, normal use is not.
    @{ Cmd = "git switch phase/5 --discard-changes"; Expect = 2; Name = "switch --discard-changes blocked" },
    @{ Cmd = "git switch phase/5 -f"; Expect = 2; Name = "switch -f blocked" },
    @{ Cmd = "git switch --force phase/5"; Expect = 2; Name = "switch --force blocked" },
    @{ Cmd = "git switch -C phase/5"; Expect = 2; Name = "switch -C blocked" },
    @{ Cmd = "git switch --force-create phase/5"; Expect = 2; Name = "switch --force-create blocked" },
    @{ Cmd = "git switch -c phase/6-study-engine origin/main"; Expect = 0; Name = "switch -c allowed" },
    @{ Cmd = "git switch main"; Expect = 0; Name = "switch to main allowed" },
    @{ Cmd = "git branch -D phase/5"; Expect = 2; Name = "branch -D" },
    @{ Cmd = "git branch -d phase/5"; Expect = 2; Name = "branch -d" },
    @{ Cmd = "git branch -Df phase/5"; Expect = 2; Name = "branch -Df clustered" },
    @{ Cmd = "git branch --delete phase/5"; Expect = 2; Name = "branch --delete" },
    # Quoted spellings: the shell strips quotes before git sees the argument.
    @{ Cmd = 'git push origin phase/5 "--force-with-lease"'; Expect = 2; Name = "quoted --force-with-lease" },
    @{ Cmd = "git push origin phase/5 '-f'"; Expect = 2; Name = "single-quoted -f" },
    @{ Cmd = 'git push origin "+phase/5"'; Expect = 2; Name = "quoted forced refspec" },
    @{ Cmd = 'git push origin ":phase/5"'; Expect = 2; Name = "quoted deleting refspec" },
    @{ Cmd = 'git push "--delete" origin phase/5'; Expect = 2; Name = "quoted --delete" },
    # Other prohibited operations, incl. inside compound commands.
    @{ Cmd = "git fetch origin; git reset --hard origin/main"; Expect = 2; Name = "reset --hard in compound" },
    @{ Cmd = "git clean -fd"; Expect = 2; Name = "git clean" },
    @{ Cmd = "gh pr merge 4 --squash"; Expect = 2; Name = "gh pr merge" },
    @{ Cmd = "gh repo delete owner/repo"; Expect = 2; Name = "gh repo delete" },
    # Malformed input must fail open (permission rules stay as backstop).
    @{ Raw = "not json at all"; Expect = 0; Name = "malformed payload fails open" },
    @{ Raw = ""; Expect = 0; Name = "empty payload fails open" }
)

$failures = 0
foreach ($c in $cases) {
    if ($c.ContainsKey("Raw")) {
        $payload = [string]$c.Raw
    } else {
        $payload = (@{ tool_name = "Bash"; tool_input = @{ command = $c.Cmd } } | ConvertTo-Json -Compress)
    }
    $tmp = [IO.Path]::GetTempFileName()
    [IO.File]::WriteAllText($tmp, $payload, (New-Object Text.UTF8Encoding $false))
    # cmd /c owns the pipe and stderr: PS 5.1 stderr redirection under
    # ErrorActionPreference=Stop would raise NativeCommandError.
    & cmd /c "type `"$tmp`" | powershell -NoProfile -ExecutionPolicy Bypass -File `"$guard`" 2>nul"
    $actual = $LASTEXITCODE
    Remove-Item $tmp -Force
    if ($actual -eq $c.Expect) {
        Write-Host ("  PASS  {0} (exit {1})" -f $c.Name, $actual) -ForegroundColor Green
    } else {
        Write-Host ("  FAIL  {0}: expected exit {1}, got {2}" -f $c.Name, $c.Expect, $actual) -ForegroundColor Red
        $failures++
    }
}

if ($failures -gt 0) {
    Write-Host "GUARD TESTS FAILED: $failures of $($cases.Count) case(s)" -ForegroundColor Red
    exit 1
}
Write-Host "GUARD TESTS PASSED ($($cases.Count)/$($cases.Count) cases)" -ForegroundColor Green
exit 0
