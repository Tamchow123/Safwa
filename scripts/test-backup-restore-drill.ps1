<#
.SYNOPSIS
    Table-driven tests for the safety guards in
    scripts/backup-restore-drill.ps1.

.DESCRIPTION
    Invokes the REAL script with -ValidateOnly and asserts its exit code: 0
    (guards pass) or 1 (refused). Testing the real script rather than a copy of
    its pattern is the whole point -- a duplicated regex would let the two drift,
    and the thing being protected is production data.

    Covers the accepted disposable names, the production-shaped names that must
    be refused, the NODE_ENV gate, and malformed or absent connection strings.
    Nothing here touches a database: -ValidateOnly returns before any decryption
    or restore, so these cases are safe to run anywhere, including CI.

.OUTPUTS
    Exit 0 when every case passes, 1 otherwise.
#>
$ErrorActionPreference = "Stop"

$repoRoot = & git rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: not in a git repository." -ForegroundColor Red; exit 1 }
$script = Join-Path $repoRoot.Trim() "scripts\backup-restore-drill.ps1"
if (-not (Test-Path -LiteralPath $script)) {
    Write-Host "ERROR: $script not found." -ForegroundColor Red
    exit 1
}

# NODE_ENV is set per-case rather than globally, because one of the cases is
# specifically about it being wrong.
$cases = @(
    # --- Accepted: the disposable names db/reset-test-database.ts allows -------
    @{ Name = "safwa_test accepted";                 NodeEnv = "test"; Url = "postgres://u:p@localhost:5432/safwa_test";          Expect = 0 },
    @{ Name = "safwa_test_<worker> accepted";        NodeEnv = "test"; Url = "postgres://u:p@localhost:5432/safwa_test_worker3";  Expect = 0 },
    @{ Name = "safwa_test with query params";        NodeEnv = "test"; Url = "postgres://u:p@host/safwa_test?sslmode=require";    Expect = 0 },
    @{ Name = "safwa_test on a Neon-looking host";   NodeEnv = "test"; Url = "postgres://u:p@ep-cool-123.eu-central-1.aws.neon.tech/safwa_test?sslmode=require"; Expect = 0 },

    # --- Refused: the ones that would destroy real data -----------------------
    @{ Name = "production database refused";         NodeEnv = "test"; Url = "postgres://u:p@host/safwa";              Expect = 1 },
    @{ Name = "safwa_prod refused";                  NodeEnv = "test"; Url = "postgres://u:p@host/safwa_prod";         Expect = 1 },
    @{ Name = "production refused";                  NodeEnv = "test"; Url = "postgres://u:p@host/production";         Expect = 1 },
    @{ Name = "postgres refused";                    NodeEnv = "test"; Url = "postgres://u:p@host/postgres";           Expect = 1 },
    @{ Name = "neondb refused";                      NodeEnv = "test"; Url = "postgres://u:p@host/neondb";             Expect = 1 },
    # Near-misses. These are the ones a looser pattern would wave through.
    @{ Name = "safwa_testing refused (not a suffix match)"; NodeEnv = "test"; Url = "postgres://u:p@host/safwa_testing"; Expect = 1 },
    @{ Name = "safwa_test-1 refused (hyphen is not a word char)"; NodeEnv = "test"; Url = "postgres://u:p@host/safwa_test-1";  Expect = 1 },
    # .NET's \w matches Unicode letters where JavaScript's does not, so the
    # obvious transliteration of the TypeScript pattern would accept this while
    # db/reset-test-database.ts refuses it. The guard spells the class out as
    # [A-Za-z0-9_] to keep the two identical; this case is what holds it there.
    @{ Name = "non-ASCII suffix refused (matches the JS \w, not .NET's)"; NodeEnv = "test"; Url = "postgres://u:p@host/safwa_test_w%C3%B6rker"; Expect = 1 },
    @{ Name = "multi-segment path refused";                NodeEnv = "test"; Url = "postgres://u:p@host/safwa_test/extra"; Expect = 1 },
    @{ Name = "trailing whitespace refused";               NodeEnv = "test"; Url = "postgres://u:p@host/safwa_test%20";   Expect = 1 },
    @{ Name = "libpq keyword form refused (not a URL we can read)"; NodeEnv = "test"; Url = "host=db.example.com dbname=safwa"; Expect = 1 },
    @{ Name = "NODE_ENV=TEST refused (case-sensitive)";    NodeEnv = "TEST"; Url = "postgres://u:p@host/safwa_test";      Expect = 1 },
    @{ Name = "prefixed safwa_test refused";               NodeEnv = "test"; Url = "postgres://u:p@host/my_safwa_test";  Expect = 1 },
    @{ Name = "SAFWA_TEST refused (case-sensitive)";       NodeEnv = "test"; Url = "postgres://u:p@host/SAFWA_TEST";      Expect = 1 },

    # --- Refused: the NODE_ENV gate ------------------------------------------
    @{ Name = "NODE_ENV=production refused even for safwa_test"; NodeEnv = "production"; Url = "postgres://u:p@host/safwa_test"; Expect = 1 },
    @{ Name = "NODE_ENV unset refused";                          NodeEnv = "";           Url = "postgres://u:p@host/safwa_test"; Expect = 1 },
    @{ Name = "NODE_ENV=development refused";                    NodeEnv = "development"; Url = "postgres://u:p@host/safwa_test"; Expect = 1 },

    # --- Refused: nothing usable to check ------------------------------------
    @{ Name = "no database in the URL refused";      NodeEnv = "test"; Url = "postgres://u:p@host";     Expect = 1 },
    @{ Name = "unparseable target refused";          NodeEnv = "test"; Url = "not a url at all";       Expect = 1 },
    # Omit = pass no -TargetDatabaseUrl at all, with the env default cleared, so
    # this exercises the "nothing supplied" path. Passing an empty string as a
    # -File argument is not the same thing: PowerShell drops it during argument
    # binding, so the next token would be bound instead and the case would test
    # something other than what it says.
    @{ Name = "absent target refused";               NodeEnv = "test"; Omit = $true;                   Expect = 1 }
)

$failures = 0

# --- The two guards must stay literally identical ----------------------------
# scripts/backup-restore-drill.ps1 and db/reset-test-database.ts each carry their
# own copy of the accepted-database-name pattern, because the restore script has
# to run standalone on an operator's machine with no Node toolchain. A comment
# saying "change both" is not a mechanism, so this compares the two literals and
# fails the gate when they drift (Phase 18 review ARCH-002).
#
# Compared after normalising the ONE difference that is intentional and
# documented in both files: .NET's \w is Unicode-aware and JavaScript's is not,
# so the PowerShell copy spells out [A-Za-z0-9_] where the TypeScript copy writes
# \w. Anything else differing is a real divergence.
$psSource = Get-Content -Raw (Join-Path $repoRoot.Trim() "scripts\backup-restore-drill.ps1")
$tsSource = Get-Content -Raw (Join-Path $repoRoot.Trim() "db\reset-test-database.ts")

$psMatch = [regex]::Match($psSource, "(?m)^\`$TestDatabaseNamePattern\s*=\s*'([^']+)'")
$tsMatch = [regex]::Match($tsSource, "(?m)^const TEST_DATABASE_NAME_PATTERN\s*=\s*/(.+)/;")

if (-not $psMatch.Success) {
    Write-Host "  FAIL  could not find `$TestDatabaseNamePattern in backup-restore-drill.ps1" -ForegroundColor Red
    $failures++
} elseif (-not $tsMatch.Success) {
    Write-Host "  FAIL  could not find TEST_DATABASE_NAME_PATTERN in db/reset-test-database.ts" -ForegroundColor Red
    $failures++
} else {
    $psPattern = $psMatch.Groups[1].Value
    $tsPattern = $tsMatch.Groups[1].Value
    $normalised = $psPattern.Replace('[A-Za-z0-9_]', '\w')
    if ($normalised -ceq $tsPattern) {
        Write-Host ("  PASS  guard pattern matches db/reset-test-database.ts ({0})" -f $tsPattern) -ForegroundColor DarkGray
    } else {
        Write-Host "  FAIL  guard patterns have diverged:" -ForegroundColor Red
        Write-Host ("          backup-restore-drill.ps1 : {0}  (normalises to {1})" -f $psPattern, $normalised) -ForegroundColor Red
        Write-Host ("          reset-test-database.ts   : {0}" -f $tsPattern) -ForegroundColor Red
        $failures++
    }
}

$originalNodeEnv = $env:NODE_ENV
$originalTargetUrl = $env:SAFWA_RESTORE_TARGET_URL

# The child is a native command whose stderr Windows PowerShell 5.1 wraps in an
# ErrorRecord; with "Stop" that aborts this harness on the first refusal that
# writes to stderr, which is most of the cases it exists to check. Exit codes are
# what is being asserted, and those are read explicitly below.
$ErrorActionPreference = "Continue"

foreach ($case in $cases) {
    $env:NODE_ENV = $case.NodeEnv
    # Cleared for every case, so the parameter passed below is the only source of
    # a target and no case can inherit one from the shell that ran this.
    $env:SAFWA_RESTORE_TARGET_URL = $null

    if ($case.Omit) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $script -ValidateOnly *> $null
    } else {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $script `
            -ValidateOnly -TargetDatabaseUrl $case.Url *> $null
    }
    $actual = $LASTEXITCODE

    if ($actual -eq $case.Expect) {
        Write-Host ("  PASS  {0}" -f $case.Name) -ForegroundColor DarkGray
    } else {
        Write-Host ("  FAIL  {0} -- expected exit {1}, got {2}" -f $case.Name, $case.Expect, $actual) -ForegroundColor Red
        $failures++
    }
}

$env:NODE_ENV = $originalNodeEnv
$env:SAFWA_RESTORE_TARGET_URL = $originalTargetUrl

# The pattern cross-check above is one assertion on top of the case table.
$checks = $cases.Count + 1

Write-Host ""
if ($failures -eq 0) {
    Write-Host ("Restore-drill guard: all {0} checks passed." -f $checks) -ForegroundColor Green
    exit 0
}
Write-Host ("Restore-drill guard: {0} of {1} checks FAILED." -f $failures, $checks) -ForegroundColor Red
exit 1
