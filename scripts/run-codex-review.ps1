<#
.SYNOPSIS
    Runs the independent, strictly read-only Codex review of the current phase.

.DESCRIPTION
    Loads .claude/review/codex-review-prompt.md, substitutes the base branch,
    and runs `codex exec` non-interactively in an ephemeral, read-only sandbox
    with a strict JSON output schema. The final response is saved to
    .claude/review/results/latest.json.

    Exit codes:
      0 - Codex returned APPROVED (with no P0/P1/P2 findings)
      2 - Codex returned CHANGES_REQUIRED
      1 - execution, authentication, parsing, configuration or consistency failure

    Codex execution failure is NEVER treated as approval.

.PARAMETER BaseBranch
    Base ref to review against. Defaults to the repository's detected
    remote primary branch (origin/HEAD), falling back to 'origin/main'.
    Prefer remote-qualified refs (origin/main): a stale local main would
    otherwise make the review include unrelated upstream changes.

.PARAMETER RequirementsFile
    Optional path to a file containing the phase requirements (objective,
    scope, non-goals, acceptance criteria) for this review. Its content is
    injected into the review prompt so Codex judges against the same
    criteria as the implementer and the Claude reviewer. When omitted,
    Codex is told to use docs/IMPLEMENTATION_PHASES.md as the sole
    acceptance source.
#>
[CmdletBinding()]
param(
    [string]$BaseBranch = "",
    [string]$RequirementsFile = ""
)

$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 defaults $OutputEncoding to ASCII, which corrupts
# every non-ASCII character (em-dashes, Arabic transliteration) piped to a
# native process. Force UTF-8 (no BOM) for the stdin pipe to Codex.
$OutputEncoding = New-Object System.Text.UTF8Encoding $false

function Fail([string]$Message) {
    Write-Host ""
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

# Shared content-level workspace fingerprint (also used by /phase-loop to
# verify the Claude reviewer changed nothing).
. (Join-Path $PSScriptRoot "workspace-fingerprint.ps1")

# --- Locate the repository root -------------------------------------------
# (No stderr redirection: under EAP=Stop, PS 5.1 turns redirected native
# stderr into terminating NativeCommandError.)
$repoRoot = & git rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($repoRoot)) {
    Fail "The current directory is not inside a Git repository."
}
$repoRoot = $repoRoot.Trim()
Set-Location $repoRoot

# --- Verify codex is installed ---------------------------------------------
$codexCmd = Get-Command codex -ErrorAction SilentlyContinue
if ($null -eq $codexCmd) {
    Fail "The 'codex' CLI is not installed or not on PATH. Install it and run 'codex login' once."
}

# --- Detect the base branch when not supplied ------------------------------
if ([string]::IsNullOrWhiteSpace($BaseBranch)) {
    $originHead = & git symbolic-ref --quiet --short refs/remotes/origin/HEAD
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($originHead)) {
        # Keep the remote-qualified ref (origin/<branch>) so the review base
        # matches the branch-creation base even when local main is stale.
        $BaseBranch = $originHead.Trim()
    } else {
        $BaseBranch = "origin/main"
    }
}
& git rev-parse --verify --quiet $BaseBranch | Out-Null
if ($LASTEXITCODE -ne 0) {
    Fail "Base ref '$BaseBranch' does not exist. Run 'git fetch origin' first."
}

# --- Paths ------------------------------------------------------------------
$promptPath = Join-Path $repoRoot ".claude\review\codex-review-prompt.md"
$schemaPath = Join-Path $repoRoot ".claude\review\codex-review.schema.json"
$resultsDir = Join-Path $repoRoot ".claude\review\results"
$resultPath = Join-Path $resultsDir "latest.json"

if (-not (Test-Path $promptPath)) { Fail "Prompt file not found: $promptPath" }
if (-not (Test-Path $schemaPath)) { Fail "Schema file not found: $schemaPath" }
if (-not (Test-Path $resultsDir)) {
    New-Item -ItemType Directory -Path $resultsDir -Force | Out-Null
}

# --- Build the prompt --------------------------------------------------------
$prompt = Get-Content -Path $promptPath -Raw -Encoding UTF8
$prompt = $prompt.Replace("{{BASE_BRANCH}}", $BaseBranch)

$requirementsText = "No phase-requirements file was supplied for this run. Use the matching phase section of docs/IMPLEMENTATION_PHASES.md as the acceptance source."
if (-not [string]::IsNullOrWhiteSpace($RequirementsFile)) {
    if (-not (Test-Path $RequirementsFile)) {
        Fail "Requirements file not found: $RequirementsFile"
    }
    $requirementsText = Get-Content -Path $RequirementsFile -Raw -Encoding UTF8
}
$prompt = $prompt.Replace("{{PHASE_REQUIREMENTS}}", $requirementsText)

# --- Snapshot the working tree so we can prove Codex changed nothing --------
$fingerprintBefore = Get-WorkspaceFingerprint

# --- Run Codex ---------------------------------------------------------------
Write-Host "Running Codex review against base branch '$BaseBranch'..." -ForegroundColor Cyan
if (Test-Path $resultPath) { Remove-Item $resultPath -Force }

# The prompt is passed via stdin ('-' argument) to avoid fragile multiline
# argument quoting. The sandbox is ephemeral and read-only: Codex cannot
# write to the working tree or persist session state.
$prompt | & codex exec --ephemeral --sandbox read-only --output-schema $schemaPath -o $resultPath --color never -
$codexExit = $LASTEXITCODE

# --- Verify Codex made no working-tree changes -------------------------------
$fingerprintAfter = Get-WorkspaceFingerprint
if ($fingerprintBefore -ne $fingerprintAfter) {
    Fail "Workspace content changed while Codex was running (HEAD, staged/unstaged tracked content, or untracked file bytes differ). The review does not describe the current tree; rerun it."
}

if ($codexExit -ne 0) {
    Fail "Codex exited with code $codexExit (execution or authentication failure). This is NOT an approval."
}

# --- Parse and validate the result -------------------------------------------
if (-not (Test-Path $resultPath)) {
    Fail "Codex did not produce a result file at $resultPath."
}

$raw = Get-Content -Path $resultPath -Raw -Encoding UTF8
if ([string]::IsNullOrWhiteSpace($raw)) {
    Fail "Codex produced an empty result file."
}

try {
    $result = $raw | ConvertFrom-Json
} catch {
    Fail "Codex output is not valid JSON: $($_.Exception.Message)"
}

$validDecisions = @("APPROVED", "CHANGES_REQUIRED")
if ($null -eq $result.decision -or ($validDecisions -notcontains $result.decision)) {
    Fail "Codex output has a missing or invalid 'decision' field."
}
if ($null -eq $result.PSObject.Properties["findings"]) {
    Fail "Codex output is missing the 'findings' field."
}

$findings = @($result.findings)
$actionable = @($findings | Where-Object { @("P0", "P1", "P2") -contains $_.severity })

# --- Print the review ---------------------------------------------------------
Write-Host ""
Write-Host "===== Codex review result =====" -ForegroundColor Cyan
Write-Host "Decision : $($result.decision)"
Write-Host "Summary  : $($result.summary)"
Write-Host "Findings : $($findings.Count) total, $($actionable.Count) actionable (P0-P2)"
Write-Host ""

foreach ($f in $findings) {
    $lineText = "(file-level)"
    if ($null -ne $f.line) { $lineText = "line $($f.line)" }
    Write-Host "[$($f.severity)] $($f.title)" -ForegroundColor Yellow
    Write-Host "  File            : $($f.file) $lineText"
    Write-Host "  Failure scenario: $($f.failure_scenario)"
    Write-Host "  Explanation     : $($f.explanation)"
    Write-Host "  Suggested fix   : $($f.suggested_fix)"
    Write-Host ""
}

# --- Consistency checks: decision and severities must agree both ways --------
if ($result.decision -eq "APPROVED" -and $actionable.Count -gt 0) {
    Fail "Inconsistent review: decision is APPROVED but $($actionable.Count) P0/P1/P2 finding(s) exist. Treating as NOT approved."
}
if ($result.decision -eq "CHANGES_REQUIRED" -and $actionable.Count -eq 0) {
    Fail "Inconsistent review: decision is CHANGES_REQUIRED but no P0/P1/P2 findings exist (P3 findings alone are non-blocking). Rerun the review; this is a failure, not an approval."
}

Write-Host "Full result saved to: $resultPath" -ForegroundColor DarkGray

if ($result.decision -eq "APPROVED") {
    Write-Host "Codex review: APPROVED" -ForegroundColor Green
    exit 0
}

Write-Host "Codex review: CHANGES_REQUIRED" -ForegroundColor Yellow
exit 2
