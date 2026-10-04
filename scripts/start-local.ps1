param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$workspacePath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimePath = Join-Path $workspacePath '.runtime'
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$pnpmExecutable = (Get-Command pnpm.cmd -ErrorAction Stop).Source

function Wait-HttpReady([string]$Url, [System.Diagnostics.Process]$Process, [bool]$ApiHealth) {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    if ($Process -and $Process.HasExited) { throw 'Application exited before readiness; inspect .runtime logs.' }
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
      if ($response.StatusCode -eq 200 -and (-not $ApiHealth -or ($response.Content | ConvertFrom-Json).status -eq 'ok')) { return }
    } catch { }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Readiness timeout for $Url; inspect .runtime logs."
}

Push-Location -LiteralPath $workspacePath
try {
  if (-not (Test-Path -LiteralPath 'node_modules/tsx')) { throw 'Dependencies missing. Run pnpm install --frozen-lockfile first.' }
  & (Join-Path $PSScriptRoot 'local-services.ps1')
  $localConfig = @'
process.loadEnvFile('.env');
console.log(JSON.stringify({local:process.env.NODE_ENV!=='production'&&process.env.APP_ORIGIN==='http://127.0.0.1:5173'&&process.env.API_HOST==='127.0.0.1'&&process.env.API_PORT==='4100',liveDisabled:process.env.ENABLE_LIVE_EXECUTION!=='true'}));
'@ | & $nodeExecutable --input-type=module
  if ($LASTEXITCODE -ne 0) { throw 'Cannot read local configuration; values were not printed.' }
  $config = $localConfig | ConvertFrom-Json
  if (-not $config.local -or -not $config.liveDisabled) { throw 'This helper requires local defaults (5173/4100, loopback, live disabled). Use the deployment runbook for other environments.' }

  $services = @(
    @{Name='api'; Entry=(Join-Path $workspacePath 'dist/server/api/src/index.js'); Port=4100; Arguments=@('--env-file=.env')},
    @{Name='worker'; Entry=(Join-Path $workspacePath 'dist/server/worker/src/index.js'); Port=0; Arguments=@('--env-file=.env')},
    @{Name='web'; Entry=(Join-Path $workspacePath 'node_modules/vite/bin/vite.js'); Port=5173; Arguments=@()}
  )
  foreach ($service in $services) {
    $pidFile = Join-Path $runtimePath "$($service.Name).pid"
    $existing = $null
    if (Test-Path -LiteralPath $pidFile) {
      $savedId = 0
      if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$savedId)) {
        $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$savedId"
        if ($existing -and ($existing.Name -ne 'node.exe' -or -not $existing.CommandLine -or $existing.CommandLine.IndexOf($service.Entry, [StringComparison]::OrdinalIgnoreCase) -lt 0)) { throw "Saved $($service.Name) PID belongs to a different process. No process was stopped." }
      }
    }
    $service.Existing = $existing
    if ($service.Port) {
      $listeners = @(Get-NetTCPConnection -LocalPort $service.Port -State Listen -ErrorAction SilentlyContinue)
      if ($listeners.Count -gt 0 -and (-not $existing -or @($listeners | Where-Object { $_.OwningProcess -ne $existing.ProcessId }).Count -gt 0)) { throw "Port $($service.Port) is occupied by an untracked process. No process was stopped." }
    }
  }
  $active = @($services | Where-Object { $_.Existing })
  if ($active.Count -eq 0) {
    & $pnpmExecutable db:migrate
    if ($LASTEXITCODE -ne 0) { throw 'Database migration failed.' }
    if (-not $SkipBuild) {
      & $pnpmExecutable build
      if ($LASTEXITCODE -ne 0) { throw 'Build failed; applications were not started.' }
    }
  } elseif (-not $SkipBuild) {
    Write-Output 'Existing project processes detected; reusing their current build. Stop them explicitly before rebuilding.'
  }

  foreach ($service in $services) {
    if ($service.Existing) {
      $service.Process = Get-Process -Id $service.Existing.ProcessId
      continue
    }
    if (-not (Test-Path -LiteralPath $service.Entry)) { throw 'Built entry point missing; run pnpm build.' }
    $arguments = @($service.Arguments) + @('"' + $service.Entry + '"')
    if ($service.Name -eq 'web') { $arguments += @('--config', ('"' + (Join-Path $workspacePath 'apps/web/vite.config.ts') + '"')) }
    $service.Process = Start-Process -FilePath $nodeExecutable -ArgumentList $arguments -WorkingDirectory $workspacePath -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimePath "$($service.Name).out.log") -RedirectStandardError (Join-Path $runtimePath "$($service.Name).err.log")
    $service.Process.Id | Set-Content -LiteralPath (Join-Path $runtimePath "$($service.Name).pid")
    Write-Output "$($service.Name) started: PID $($service.Process.Id)"
  }
  Wait-HttpReady 'http://127.0.0.1:4100/api/health' $services[0].Process $true
  Wait-HttpReady 'http://127.0.0.1:5173' $services[2].Process $false
  $deadline = [DateTime]::UtcNow.AddSeconds(40)
  $healthy = $false
  do {
    if ($services[1].Process.HasExited) { throw 'Worker exited; inspect .runtime/worker.err.log and worker.out.log.' }
    & $nodeExecutable --import tsx --env-file=.env scripts/worker-health.ts *> $null
    if ($LASTEXITCODE -eq 0) { $healthy = $true; break }
    Start-Sleep -Milliseconds 750
  } while ([DateTime]::UtcNow -lt $deadline)
  if (-not $healthy) { throw 'Worker heartbeat or operations queue is not ready; inspect .runtime logs.' }
  Write-Output 'Local API, dashboard and worker are healthy: http://127.0.0.1:5173'
  Write-Output 'Paper/live control remains as saved. Closing the browser does not stop the worker. VPS deployment is separate.'
} finally { Pop-Location }
