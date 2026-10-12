[CmdletBinding()]
param([ValidateSet('Prepare', 'Start', 'Stop', 'Status')][string]$Action = 'Start')

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Set-Location -LiteralPath $repoRoot
$env:HUSKY = '0'
$env:COREPACK_HOME = Join-Path $repoRoot '.runtime\corepack'
$legacyCache = Join-Path (Split-Path -Parent $repoRoot) 'plane-main\.runtime'
if (Test-Path -LiteralPath (Join-Path $legacyCache 'corepack')) {
    $env:COREPACK_HOME = Join-Path $legacyCache 'corepack'
}
$storePath = Join-Path $repoRoot '.runtime\pnpm-store'
if (Test-Path -LiteralPath (Join-Path $legacyCache 'pnpm-store')) {
    $storePath = Join-Path $legacyCache 'pnpm-store'
}
$env:npm_config_store_dir = $storePath
$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
$dockerPath = if ($dockerCommand) { $dockerCommand.Source } else { 'D:\Applications\DockerDesktop\resources\bin\docker.exe' }
if (-not (Test-Path -LiteralPath $dockerPath)) { throw 'Docker CLI not found.' }
$env:PATH = (Split-Path -Parent $dockerPath) + [IO.Path]::PathSeparator + $env:PATH

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program exited with code $LASTEXITCODE." }
}
foreach ($path in @('.env', 'apps/web/.env', 'apps/admin/.env', 'apps/space/.env', 'apps/live/.env', 'apps/api/.env')) {
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $path))) {
        throw "Missing $path; restore the existing local configuration before starting."
    }
}
if ($Action -eq 'Prepare') {
    Invoke-Checked 'corepack' @('pnpm', 'install', '--frozen-lockfile', '--store-dir', $storePath)
    Invoke-Checked 'corepack' @('pnpm', 'turbo', 'run', 'build', '--filter=web', '--filter=admin', '--filter=space', '--filter=live', '--concurrency=2')
    return
}
$compose = @('compose', '--project-name', 'pilab-windows', '--project-directory', $repoRoot,
    '--env-file', (Join-Path $repoRoot '.env'), '-f', (Join-Path $repoRoot 'docker-compose-local.yml'),
    '-f', (Join-Path $PSScriptRoot 'compose.override.yml'))
Invoke-Checked $dockerPath ($compose + @('config', '--quiet'))
if ($Action -eq 'Status') {
    Invoke-Checked $dockerPath ($compose + @('ps', '--all'))
    & (Join-Path $PSScriptRoot 'frontend-local.ps1') -Action Status
    return
}
if ($Action -eq 'Stop') {
    & (Join-Path $PSScriptRoot 'frontend-local.ps1') -Action Stop
    Invoke-Checked $dockerPath ($compose + @('stop', 'api', 'worker', 'beat-worker'))
    Write-Output 'Plane applications stopped; infrastructure and data retained.'
    return
}
# This helper resumes this machine's existing stack. It never creates replacement
# database volumes, regenerates secrets, or upgrades infrastructure images.
Invoke-Checked $dockerPath ($compose + @('start', 'plane-db', 'plane-redis', 'plane-mq', 'plane-minio'))
Invoke-Checked $dockerPath ($compose + @('run', '--rm', '--no-deps', '--pull', 'never', 'migrator'))
Invoke-Checked $dockerPath ($compose + @('up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'api', 'worker', 'beat-worker'))
$ready = $false
for ($attempt = 0; $attempt -lt 120; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8001/' -TimeoutSec 5
        if ($health.status -eq 'OK') { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 2
}
if (-not $ready) { throw 'API did not become ready; inspect container logs.' }
& (Join-Path $PSScriptRoot 'frontend-local.ps1') -Action Start
Write-Output 'Web: http://localhost:3000 | Admin: http://localhost:3001/god-mode/'
