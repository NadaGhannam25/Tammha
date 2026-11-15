# One-run local-only security update. Does NOT connect to Supabase or migrate data.
# Fail-safe: restores both package manifests if npm install or tests fail.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$backupDir = Join-Path $root '.security-backup'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$pkgBackup = Join-Path $backupDir 'package.json'
$lockBackup = Join-Path $backupDir 'package-lock.json'
Copy-Item (Join-Path $root 'package.json') $pkgBackup -Force
Copy-Item (Join-Path $root 'package-lock.json') $lockBackup -Force
$log = Join-Path $root 'security-results.txt'
$reportStarted = $false
$verified = $false
try {
    Start-Transcript -Path $log -Force | Out-Null
    $reportStarted = $true
    Write-Host 'TAMMHA SECURITY PATCH / LOCAL VERIFICATION'
    Write-Host 'No database command will be run.'
    Write-Host '--- Node / npm ---'
    node -v
    npm -v
    Write-Host '--- Apply targeted dependency overrides ---'
    & node (Join-Path $root 'scripts\apply-targeted-overrides.js')
    if ($LASTEXITCODE -ne 0) { throw 'Could not edit package.json.' }
    Write-Host '--- Resolve dependencies and update lockfile ---'
    & npm install --no-audit
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed; changes will be rolled back.' }
    Write-Host '--- Full project verification (Prisma schema / types / lint / tests / build) ---'
    & npm run verify
    if ($LASTEXITCODE -ne 0) { throw 'Full verification failed; changes will be rolled back.' }
    $verified = $true
    Write-Host '--- Production vulnerability audit ---'
    & npm audit --omit=dev
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'NOTE: Audit reports unresolved advisories (or a registry issue). See above.'
        Write-Host 'The successful test/build update is retained; do not deploy until reviewed.'
    }
    Write-Host '--- Installed security-relevant versions ---'
    & npm ls multer qs lodash body-parser js-yaml uuid --all
    Write-Host '--- Remaining database migrations ---'
    & node (Join-Path $root 'scripts\migration-review.js')
    Write-Host 'DONE. Tests passed. Do not deploy until audit and migrations are reviewed.'
} catch {
    Write-Host ('ERROR: ' + $_.Exception.Message)
    Write-Host 'Restoring previous package.json and package-lock.json.'
    Copy-Item $pkgBackup (Join-Path $root 'package.json') -Force
    Copy-Item $lockBackup (Join-Path $root 'package-lock.json') -Force
    Write-Host 'The original manifests have been restored.'
    Write-Host 'Dependency directory may still reflect the attempted install; run npm ci before using it.'
} finally {
    if ($reportStarted) { Stop-Transcript | Out-Null }
}
if ($verified) { exit 0 } else { exit 1 }
