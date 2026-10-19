[CmdletBinding()]
param([ValidateSet('Start', 'Stop', 'Status')][string]$Action = 'Start')

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$runtime = Join-Path $repoRoot '.runtime\windows\native-mcp'
$recordPath = Join-Path $runtime 'process.json'
$configPath = Join-Path $runtime 'http.local.json'
$appRoot = Join-Path $repoRoot 'demos\sciencediscovery-plane-mcp'
$owned = $null
if (Test-Path -LiteralPath $recordPath) {
    $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)"
    if ($candidate -and $candidate.CommandLine -and
        $candidate.CommandLine.IndexOf($appRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        ([datetime]$candidate.CreationDate).ToUniversalTime().Ticks -eq [long]$record.creationTicks) {
        $owned = $candidate
    }
}
if ($Action -eq 'Status') { Write-Output "Local administrative MCP running=$($null -ne $owned)"; return }
if ($Action -eq 'Stop') {
    if ($owned) { Stop-Process -Id $owned.ProcessId -ErrorAction Stop }
    if (Test-Path -LiteralPath $recordPath) { Remove-Item -LiteralPath $recordPath }
    Write-Output 'Local administrative MCP stopped; credential store retained.'
    return
}
if ($owned) { Write-Output 'Local administrative MCP already running.'; return }
if (-not (Test-Path -LiteralPath $configPath)) {
    throw 'Create .runtime/windows/native-mcp/http.local.json from the local self-service example and choose local workspace slugs first.'
}
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($config.host -ne '127.0.0.1' -or $config.port -ne 8765 -or
    $config.self_service.public_url -ne 'http://localhost:8765' -or
    $config.self_service.plane_base_url -ne 'http://127.0.0.1:8001' -or
    $config.self_service.plane_ui_url -ne 'http://localhost:3000' -or
    @($config.clients).Count -ne 0 -or
    -not $config.self_service.workspaces.Count -or
    $config.self_service.workspaces -contains 'REPLACE_LOCAL_WORKSPACE') {
    throw 'The local MCP helper requires loopback-only origins and explicit local workspace slugs.'
}
$pythonPath = Join-Path $appRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) { throw 'Install the existing MCP runtime requirements in the demo .venv first.' }
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 8765)
try { $listener.Start() } finally { $listener.Stop() }
$process = Start-Process -FilePath $pythonPath -ArgumentList @(
    ('"' + (Join-Path $appRoot 'http_mcp.py') + '"'), '--config', ('"' + $configPath + '"')
) -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $runtime 'stdout.log') `
    -RedirectStandardError (Join-Path $runtime 'stderr.log')
$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)"
if (-not $processInfo) { throw 'Local MCP failed to start; inspect its private runtime logs.' }
@{ pid = $process.Id; creationTicks = ([datetime]$processInfo.CreationDate).ToUniversalTime().Ticks } |
    ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding UTF8
Write-Output 'Administrative MCP: http://localhost:8765/mcp | Portal: http://localhost:8765/connect'
