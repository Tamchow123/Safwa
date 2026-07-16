<#
.SYNOPSIS
    Content-level fingerprint of the reviewable workspace state.

.DESCRIPTION
    Defines Get-WorkspaceFingerprint, covering HEAD, staged and unstaged
    tracked content, and each untracked file's bytes (gitignored files
    excluded). A porcelain-status comparison alone cannot detect content
    changes to files that were ALREADY modified or untracked - the normal
    state during a phase, since reviews run before the phase commit.

    Dot-source this file to use the function (the Codex runner does), or
    invoke it directly to print a single SHA-256 digest line. The /phase-loop
    skill captures the digest before and after the Claude reviewer runs:
    subagent permission modes are not guaranteed to survive every parent
    permission mode, so reviewer read-onlyness is verified by detection, the
    same way the Codex runner verifies its sandbox.
#>

function Get-WorkspaceFingerprint {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("HEAD:" + ((& git rev-parse HEAD) -join ""))
    $stagedDiff = (& git diff --cached --no-color | Out-String)
    $lines.Add("STAGED:" + [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($stagedDiff))))
    $workDiff = (& git diff --no-color | Out-String)
    $lines.Add("WORKTREE:" + [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($workDiff))))
    $untracked = @(& git ls-files --others --exclude-standard) | Sort-Object
    foreach ($u in $untracked) {
        $hash = ""
        if (Test-Path -LiteralPath $u -PathType Leaf) {
            $hash = (Get-FileHash -LiteralPath $u -Algorithm SHA256).Hash
        }
        $lines.Add("UNTRACKED:${u}:$hash")
    }
    return ($lines -join "`n")
}

if ($MyInvocation.InvocationName -ne ".") {
    $ErrorActionPreference = "Stop"
    $repoRoot = & git rev-parse --show-toplevel
    if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: not in a git repository."; exit 1 }
    Set-Location $repoRoot.Trim()
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $digest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes((Get-WorkspaceFingerprint)))).Replace("-", "")
    Write-Output $digest
    exit 0
}
