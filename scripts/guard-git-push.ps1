<#
.SYNOPSIS
    PreToolUse hook: blocks destructive git/gh operations in any argument
    position, regardless of permission allow rules.

.DESCRIPTION
    Claude Code permission rules match command prefixes, so an allow rule
    like "git push -u origin phase/*" would also match
    "git push -u origin phase/x --force-with-lease". This hook closes that
    hole: it receives the hook JSON on stdin, inspects the command of every
    Bash/PowerShell tool call, and exits 2 (block) when any segment of the
    command performs a prohibited operation:

      - git push with --force / --force-with-lease / --force-if-includes /
        -f / --mirror / --delete, or a forced (+) or deleting (:) refspec
      - git reset --hard
      - git clean
      - git branch -d / -D / --delete
      - git push to a deleted ref, gh pr merge, gh repo delete

    Exit 0 allows the call; exit 2 blocks it and feeds stderr back to the
    agent. Any parsing problem fails open (exit 0) so the hook can never
    brick unrelated tool use - the permission deny rules remain as the
    first-position backstop.
#>
$ErrorActionPreference = "Stop"

$raw = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }

try {
    $payload = $raw | ConvertFrom-Json
} catch {
    exit 0
}

$command = $null
if ($null -ne $payload.tool_input -and $null -ne $payload.tool_input.command) {
    $command = [string]$payload.tool_input.command
}
if ([string]::IsNullOrWhiteSpace($command)) { exit 0 }

# Examine each simple-command segment so flags are attributed to the right
# command in compound lines (a && b; c | d).
$segments = $command -split "\|\||&&|;|\|"
$violations = @()

foreach ($segment in $segments) {
    $s = " " + $segment.Trim() + " "
    # Token-by-token inspection: git accepts clustered short options
    # (git push -fu, git branch -Df), so substring/regex checks on the raw
    # line are not sufficient. Strip surrounding quotes from every token -
    # the shell removes them before git sees the argument, so
    # `git push origin "--force-with-lease"` is still a force push.
    $tokens = @($segment.Trim() -split "\s+" |
        ForEach-Object { $_.Trim("'").Trim('"') } |
        Where-Object { $_ -ne "" })

    if ($s -match "\sgit(\.exe)?\s+push\b") {
        foreach ($t in $tokens) {
            if ($t -like "--force*") { $violations += "force push"; continue }
            if ($t -eq "--mirror") { $violations += "mirror push"; continue }
            if ($t -eq "--delete") { $violations += "remote branch deletion"; continue }
            if ($t -match "^-[A-Za-z]+$") {
                # Clustered or standalone short options: -f forces, -d deletes.
                if ($t -match "f") { $violations += "force push (-f)" }
                if ($t -cmatch "d") { $violations += "remote branch deletion (-d)" }
                continue
            }
            if ($t -match "^\+.") { $violations += "forced refspec (+ref)"; continue }
            if ($t -match "^:.") { $violations += "deleting refspec (:ref)"; continue }
            if ($t -match "^[^:]+:(.+)$") {
                # src:dest refspec: the destination decides which remote branch
                # moves, so `git push origin phase/5:main` is a push to main.
                $dest = $Matches[1]
                if ($dest -notmatch "^(refs/heads/)?phase/") {
                    $violations += "push refspec targeting a non-phase branch ($dest)"
                }
                continue
            }
        }
    }
    if ($s -match "\sgit(\.exe)?\s+branch\b") {
        foreach ($t in $tokens) {
            if ($t -eq "--delete") { $violations += "local branch deletion"; continue }
            if ($t -match "^-[A-Za-z]+$" -and $t -match "d") { $violations += "local branch deletion" }
        }
    }
    if ($s -match "\sgit(\.exe)?\s+reset\s+(\S+\s+)*--hard\b") { $violations += "git reset --hard" }
    if ($s -match "\sgit(\.exe)?\s+clean\b") { $violations += "git clean" }
    if ($s -match "\sgh(\.exe)?\s+pr\s+merge\b") { $violations += "pull request merge" }
    if ($s -match "\sgh(\.exe)?\s+repo\s+delete\b") { $violations += "repository deletion" }
}

if ($violations.Count -gt 0) {
    $err = [Console]::Error
    $err.WriteLine("BLOCKED by scripts/guard-git-push.ps1: the phase workflow prohibits this operation:")
    foreach ($v in ($violations | Select-Object -Unique)) {
        $err.WriteLine("  - $v")
    }
    $err.WriteLine("Force pushes, remote/local branch deletion, hard resets, git clean, and merging are never permitted. Push normally, or stop and escalate to the user.")
    exit 2
}

exit 0
