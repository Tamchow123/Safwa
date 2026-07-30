<#
.SYNOPSIS
    Restore an encrypted production dump into a DISPOSABLE database, for the
    quarterly restore drill (docs/DEPLOYMENT.md section 7, phases-18.md section 9).

.DESCRIPTION
    Decrypts an `age`-encrypted custom-format dump produced by
    .github/workflows/backup.yml and restores it with `pg_restore`.

    SAFETY -- the same guard as db/reset-test-database.ts, for the same reason.
    Refuses to run unless BOTH:
      (a) NODE_ENV=test, and
      (b) the target database name matches `safwa_test` or `safwa_test_<worker>`
          exactly.
    `safwa`, `safwa_prod`, `production`, `postgres`, `neondb` and anything else
    are refused outright. There is no override switch, and adding one would
    defeat the point: this script exists to be pointed at a copy, and the one
    mistake that matters is pointing a restore at the database it was copied
    FROM. A drill that can overwrite production is not a drill.

    The decrypted plaintext is written to a temporary file and removed in a
    `finally` block, which covers a normal failure and a graceful Ctrl-C.

    It does NOT cover a forced kill (Stop-Process -Force, taskkill /F, closing
    the console window, a crash or sleep mid-restore): nothing runs on those
    paths, and what is left behind is a full plaintext copy of production
    including password hashes and live session tokens. After any abnormal end to
    a drill, check the temp directory for stray safwa-restore-*.dump files and
    delete them. docs/DEPLOYMENT.md section 7's drill checklist repeats this
    where an operator will actually be reading.

.PARAMETER DumpPath
    The `.age` file downloaded from a backup workflow run.

.PARAMETER TargetDatabaseUrl
    Postgres connection string for the disposable target. Defaults to
    $env:SAFWA_RESTORE_TARGET_URL.

.PARAMETER IdentityFile
    Path to the `age` identity (private key) file. Defaults to
    $env:SAFWA_BACKUP_AGE_IDENTITY_FILE. Deliberately a FILE path and never the
    key material itself: a key passed as an argument lands in the process list
    and in shell history.

.PARAMETER ValidateOnly
    Run the guards and exit without decrypting or restoring anything. This is
    what scripts/test-backup-restore-drill.ps1 exercises, so the guard is tested
    against the real script rather than against a copy of its logic.

.OUTPUTS
    Exit 0 on success (or on a passing -ValidateOnly check), 1 on any refusal or
    failure.
#>
param(
    [string]$DumpPath,
    [string]$TargetDatabaseUrl = $env:SAFWA_RESTORE_TARGET_URL,
    [string]$IdentityFile = $env:SAFWA_BACKUP_AGE_IDENTITY_FILE,
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"

# Mirrors TEST_DATABASE_NAME_PATTERN in db/reset-test-database.ts. If one
# changes, change both -- they are the same safety property in two languages, and
# scripts/test-backup-restore-drill.ps1 asserts mechanically that the two literals
# still match, so a divergence fails the quality gate rather than going unnoticed.
#
# [A-Za-z0-9_] rather than \w, deliberately. .NET's \w is Unicode-aware and
# matches letters from any script, while JavaScript's \w (no `u` flag) is
# ASCII-only -- so the obvious transliteration '^safwa_test(_\w+)?$' would accept
# names like safwa_test_worker with non-ASCII letters that the TypeScript guard
# refuses. Spelling the class out makes the two identical in what they accept
# instead of merely similar (Phase 18 review SEC-003).
$TestDatabaseNamePattern = '^safwa_test(_[A-Za-z0-9_]+)?$'

function Fail([string]$message) {
    Write-Host "REFUSED: $message" -ForegroundColor Red
    exit 1
}

# --- Guard (a): NODE_ENV -------------------------------------------------------
# The same first gate as db/reset-test-database.ts. It is a speed bump rather
# than a wall, and that is what it is for: nobody restores production data into
# a database by accident while their shell is deliberately in test mode.
# -cne, not -ne. PowerShell's comparison operators are case-INSENSITIVE by
# default, so -ne accepted NODE_ENV=TEST where db/reset-test-database.ts's
# `nodeEnv !== "test"` refuses it -- the same defect as the pattern's -cnotmatch
# below, found by the same self-test one case later (Phase 18 review, SEC-003's
# class of finding).
if ($env:NODE_ENV -cne "test") {
    $got = $env:NODE_ENV
    if ([string]::IsNullOrEmpty($got)) { $got = "<unset>" }
    Fail "refusing to restore outside NODE_ENV=test (got `"$got`"). Set `$env:NODE_ENV = `"test`" for this shell."
}

# --- Guard (b): the target database name --------------------------------------
if ([string]::IsNullOrWhiteSpace($TargetDatabaseUrl)) {
    Fail "no target database. Pass -TargetDatabaseUrl or set SAFWA_RESTORE_TARGET_URL."
}

$targetName = $null
try {
    $uri = [System.Uri]$TargetDatabaseUrl
    $targetName = $uri.AbsolutePath.TrimStart('/')
} catch {
    Fail "the target connection string could not be parsed as a URL."
}
if ([string]::IsNullOrWhiteSpace($targetName)) {
    Fail "the target connection string names no database."
}
# -cnotmatch, NOT -notmatch. PowerShell's -match is case-INSENSITIVE by default,
# which would accept "SAFWA_TEST" where db/reset-test-database.ts's JavaScript
# regex refuses it. The guards are supposed to be the same property in two
# languages, and this script's own self-test caught the divergence.
if ($targetName -cnotmatch $TestDatabaseNamePattern) {
    Fail @"
target database "$targetName" is not a disposable test database.
Only names matching safwa_test or safwa_test_<worker> are permitted, and there
is no override. Restore into a scratch database or a fresh Neon branch whose
database is named safwa_test, never over the database the dump came from.
"@
}

if ($ValidateOnly) {
    Write-Host "OK: guards pass for target database `"$targetName`"." -ForegroundColor Green
    exit 0
}

# --- Everything below actually moves data ------------------------------------
if ([string]::IsNullOrWhiteSpace($DumpPath)) {
    Fail "no dump. Pass -DumpPath <the .age file from a backup workflow run>."
}
if (-not (Test-Path -LiteralPath $DumpPath)) {
    Fail "dump not found at `"$DumpPath`"."
}
if ([string]::IsNullOrWhiteSpace($IdentityFile)) {
    Fail "no age identity file. Pass -IdentityFile or set SAFWA_BACKUP_AGE_IDENTITY_FILE. The private key is never accepted as an argument."
}
if (-not (Test-Path -LiteralPath $IdentityFile)) {
    Fail "age identity file not found at `"$IdentityFile`"."
}

foreach ($tool in @("age", "pg_restore")) {
    if ($null -eq (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Fail "`"$tool`" is not on PATH. The drill needs the age CLI and a PostgreSQL 17 client."
    }
}

# A version check, not a courtesy. pg_restore older than the server that
# produced the archive fails part-way through with an unhelpful error, which
# during an incident reads as "the backup is corrupt".
$restoreVersion = (& pg_restore --version) -join " "
if ($restoreVersion -notmatch "17\.") {
    Write-Host "WARNING: pg_restore reports `"$restoreVersion`". The dumps are taken with a PostgreSQL 17 client; a mismatch can fail mid-restore." -ForegroundColor Yellow
}

# Decrypt into the user's temp directory rather than beside the dump, so a
# repository checkout can never end up holding the plaintext.
$plaintext = Join-Path ([System.IO.Path]::GetTempPath()) ("safwa-restore-" + [System.Guid]::NewGuid().ToString("N") + ".dump")

try {
    Write-Host "Decrypting $DumpPath ..." -ForegroundColor Cyan
    & age --decrypt --identity $IdentityFile --output $plaintext $DumpPath
    if ($LASTEXITCODE -ne 0) { Fail "age could not decrypt the dump (wrong identity file, or a truncated artifact)." }

    $size = (Get-Item -LiteralPath $plaintext).Length
    Write-Host "Decrypted $size bytes." -ForegroundColor Cyan

    Write-Host "Restoring into `"$targetName`" ..." -ForegroundColor Cyan
    # --clean --if-exists so the drill is repeatable against the same scratch
    # database; --no-owner --no-privileges because the target's roles are not
    # production's. Errors are NOT ignored: `--exit-on-error` is what makes this
    # a drill with a verdict rather than a wall of warnings someone skims.
    & pg_restore `
        --dbname=$TargetDatabaseUrl `
        --clean --if-exists `
        --no-owner --no-privileges `
        --exit-on-error `
        $plaintext
    if ($LASTEXITCODE -ne 0) {
        # --clean --if-exists has already dropped objects by this point, so a
        # failure part-way leaves the target neither as it was nor fully
        # restored. Saying so matters: the next thing an operator does is often
        # a row count, and counting a half-restored database produces a
        # confidently wrong answer about whether the backup is good.
        Write-Host ""
        Write-Host "The target database is now PARTIALLY restored. Do not read row counts" -ForegroundColor Yellow
        Write-Host "from it and do not point the app at it -- drop and recreate it before" -ForegroundColor Yellow
        Write-Host "the next attempt." -ForegroundColor Yellow
        Fail "pg_restore exited $LASTEXITCODE. The drill FAILED -- this is the finding the drill exists to produce; record it rather than retrying blindly."
    }

    Write-Host ""
    Write-Host "Restore succeeded. The drill is NOT over -- verify the data:" -ForegroundColor Green
    Write-Host "  1. Row counts for users, review_events and study_components are non-zero"
    Write-Host "     and plausible against production."
    Write-Host "  2. Point the app at this database (DATABASE_URL) and sign in as a known"
    Write-Host "     account; its due cards and history should be there."
    Write-Host "  3. Record the date, the artifact restored, and the outcome -- the drill is"
    Write-Host "     quarterly, and after any non-additive migration (docs/DEPLOYMENT.md section 7)."
    Write-Host ""
    Write-Host "Then DROP this scratch database. It holds a full copy of production," -ForegroundColor Yellow
    Write-Host "including password hashes and session tokens." -ForegroundColor Yellow
} finally {
    # On every path, including Ctrl-C and a mid-restore failure.
    if (Test-Path -LiteralPath $plaintext) {
        Remove-Item -LiteralPath $plaintext -Force -ErrorAction SilentlyContinue
        Write-Host "Removed the decrypted copy." -ForegroundColor DarkGray
    }
}
