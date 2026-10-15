[CmdletBinding()]
param([ValidateSet('Start', 'Stop', 'Status')][string]$Action = 'Start')

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$runtime = Join-Path $repoRoot '.runtime\windows'
$recordPath = Join-Path $runtime 'frontend-processes.json'

function Get-OwnedProcess($record) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)"
    if ($process -and $process.CommandLine -and
        $process.CommandLine.IndexOf($repoRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        ([datetime]$process.CreationDate).ToUniversalTime().Ticks -eq [long]$record.creationTicks) {
        return $process
    }
    return $null
}

$records = @()
if (Test-Path -LiteralPath $recordPath) {
    $records = @(Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json)
}
if ($Action -eq 'Status') {
    foreach ($record in $records) {
        $running = $null -ne (Get-OwnedProcess $record)
        Write-Output "$($record.name): running=$running, PID=$($record.pid)"
    }
    if (-not $records.Count) { Write-Output 'No managed frontend processes.' }
    return
}
if ($Action -eq 'Stop') {
    foreach ($record in $records) {
        $process = Get-OwnedProcess $record
        if ($process) { Stop-Process -Id $process.ProcessId -ErrorAction Stop }
    }
    if (Test-Path -LiteralPath $recordPath) { Remove-Item -LiteralPath $recordPath }
    Write-Output 'Managed frontend processes stopped; data retained.'
    return
}
if (@($records | Where-Object { $null -ne (Get-OwnedProcess $_) }).Count) {
    throw 'Managed processes already exist; use Status or Stop before Start.'
}

$nodePath = (Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$specs = @(
    @{ name = 'web'; port = 3000; app = 'web'; artifact = 'build/client/index.html' },
    @{ name = 'admin'; port = 3001; app = 'admin'; artifact = 'build/client/index.html' },
    @{ name = 'space'; port = 3002; app = 'space'; artifact = 'build/server/index.js' },
    @{ name = 'live'; port = 3100; app = 'live'; artifact = 'dist/start.mjs' }
)
foreach ($spec in $specs) {
    $appRoot = Join-Path $repoRoot ('apps/' + $spec.app)
    if (-not (Test-Path -LiteralPath (Join-Path $appRoot $spec.artifact))) {
        throw "Missing build for $($spec.name); run Prepare first."
    }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, [int]$spec.port)
    try { $listener.Start() } finally { $listener.Stop() }
}

$started = @()
try {
    foreach ($spec in $specs) {
        $appRoot = Join-Path $repoRoot ('apps/' + $spec.app)
        if ($spec.name -eq 'live') {
            $arguments = @('--env-file=.env', ('"' + (Join-Path $appRoot 'dist/start.mjs') + '"'))
        } else {
            $vitePath = Join-Path $appRoot 'node_modules/vite/bin/vite.js'
            $arguments = @(('"' + $vitePath + '"'), 'preview', '--port', $spec.port, '--strictPort', '--host', '127.0.0.1')
            if ($spec.name -ne 'space') { $arguments += @('--outDir', 'build/client') }
        }
        $process = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $appRoot `
            -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $runtime ($spec.name + '.stdout.log')) `
            -RedirectStandardError (Join-Path $runtime ($spec.name + '.stderr.log'))
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)"
        if (-not $processInfo) { throw "$($spec.name) exited; inspect logs in $runtime." }
        $started += @{ name = $spec.name; pid = $process.Id; creationTicks = ([datetime]$processInfo.CreationDate).ToUniversalTime().Ticks }
    }
    ConvertTo-Json -InputObject @($started) | Set-Content -LiteralPath $recordPath -Encoding UTF8
} catch {
    foreach ($record in $started) {
        $owned = Get-OwnedProcess $record
        if ($owned) { Stop-Process -Id $owned.ProcessId }
    }
    throw
}
Write-Output "Frontends started from $repoRoot. Check HTTP health; logs: $runtime"
