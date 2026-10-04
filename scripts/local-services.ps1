$ErrorActionPreference = 'Stop'
$workspacePath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimePath = Join-Path $workspacePath '.runtime'
$pgBin = if ($env:PG_BIN) { $env:PG_BIN } else { 'C:\laragon\bin\postgresql\getfile\bin' }
$redisBin = if ($env:REDIS_BIN) { $env:REDIS_BIN } else { Join-Path $runtimePath 'redis-8.8.3/Redis-8.8.3-Windows-x64-cygwin' }
New-Item -ItemType Directory -Force $runtimePath | Out-Null
foreach ($executable in @('initdb.exe', 'pg_ctl.exe', 'postgres.exe', 'pg_isready.exe', 'psql.exe', 'createdb.exe')) {
  if (-not (Test-Path -LiteralPath (Join-Path $pgBin $executable))) { throw "Missing PostgreSQL executable: $executable. Set PG_BIN to the PostgreSQL client/server directory." }
}
foreach ($executable in @('redis-server.exe', 'redis-cli.exe')) {
  if (-not (Test-Path -LiteralPath (Join-Path $redisBin $executable))) { throw 'Set REDIS_BIN to a compatible Redis runtime. See docs/deployment.md; Laragon Redis 8.8.0 failed LREM -1 verification.' }
}
$envPath = Join-Path $workspacePath '.env'
if (-not (Test-Path -LiteralPath $envPath)) {
  $env:POLY_SETUP_ROOT = $workspacePath
  @'
const fs=require('node:fs'),path=require('node:path'),{randomBytes}=require('node:crypto');
const root=process.env.POLY_SETUP_ROOT, pass=randomBytes(24).toString('hex');
fs.writeFileSync(path.join(root,'.runtime','pg-password'),pass);
fs.writeFileSync(path.join(root,'.env'),[
'NODE_ENV=development','APP_ORIGIN=http://127.0.0.1:5173','API_HOST=127.0.0.1','API_PORT=4100',
'DATABASE_URL=postgresql://polymarket:'+pass+'@127.0.0.1:5433/polymarket','REDIS_URL=redis://127.0.0.1:6380',
'BETTER_AUTH_SECRET='+randomBytes(48).toString('hex'),'MASTER_KEY='+randomBytes(32).toString('base64'),
'BACKUP_KEY='+randomBytes(32).toString('base64'),'OWNER_EMAIL=owner@local.test','ENABLE_LIVE_EXECUTION=false',
'PG_BIN=C:/laragon/bin/postgresql/getfile/bin','AI_ENDPOINT_ALLOWLIST=','TAVILY_COST_PER_CREDIT_USD=0.008'
].join('\n')+'\n');
console.log('Created local configuration; secrets were not printed.');
'@ | node
  if ($LASTEXITCODE -ne 0) { throw 'Local configuration creation failed' }
}
$pgData = Join-Path $runtimePath 'postgres'
if (-not (Test-Path -LiteralPath (Join-Path $pgData 'PG_VERSION'))) {
  & (Join-Path $pgBin 'initdb.exe') -D $pgData -U polymarket --encoding=UTF8 --locale=C --auth=scram-sha-256 ('--pwfile=' + (Join-Path $runtimePath 'pg-password'))
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL initialization failed' }
}
& (Join-Path $pgBin 'pg_ctl.exe') -D $pgData status 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  if (Get-NetTCPConnection -State Listen -LocalPort 5433 -ErrorAction SilentlyContinue) { throw 'Port 5433 is occupied by another PostgreSQL instance or process; no process was stopped.' }
  $postgresProcess = Start-Process -FilePath (Join-Path $pgBin 'postgres.exe') -ArgumentList @('-D',('"'+$pgData+'"'),'-p','5433','-h','127.0.0.1') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'postgres.out.log') -RedirectStandardError (Join-Path $runtimePath 'postgres.err.log') -PassThru
}
$postgresReady = $false
$deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
  & (Join-Path $pgBin 'pg_isready.exe') -h 127.0.0.1 -p 5433 -U polymarket -d postgres -t 1 | Out-Null
  if ($LASTEXITCODE -eq 0) { $postgresReady = $true; break }
  if ($postgresProcess -and $postgresProcess.HasExited) { throw 'PostgreSQL exited before readiness; inspect .runtime/postgres.err.log.' }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
if (-not $postgresReady) { throw 'PostgreSQL did not become ready within 30 seconds; inspect .runtime/postgres.err.log.' }
if (-not (Get-NetTCPConnection -State Listen -LocalPort 6380 -ErrorAction SilentlyContinue)) {
  $redisProcess = Start-Process -FilePath (Join-Path $redisBin 'redis-server.exe') -ArgumentList @('--bind','127.0.0.1','--port','6380','--appendonly','yes','--dir',('"'+$runtimePath+'"'),'--maxmemory-policy','noeviction') -WorkingDirectory $redisBin -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath 'redis.out.log') -RedirectStandardError (Join-Path $runtimePath 'redis.err.log') -PassThru
}
$redisReady = $false
$deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
  $pong = & (Join-Path $redisBin 'redis-cli.exe') -h 127.0.0.1 -p 6380 PING 2>$null
  if ($LASTEXITCODE -eq 0 -and $pong -eq 'PONG') { $redisReady = $true; break }
  if ($redisProcess -and $redisProcess.HasExited) { throw 'Redis exited before readiness; inspect .runtime/redis.err.log.' }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
if (-not $redisReady) { throw 'Redis did not become ready within 30 seconds; inspect .runtime/redis.err.log.' }
$previousPgPassword = $env:PGPASSWORD
$env:PGPASSWORD = [System.IO.File]::ReadAllText((Join-Path $runtimePath 'pg-password'))
try {
  $exists = & (Join-Path $pgBin 'psql.exe') -h 127.0.0.1 -p 5433 -U polymarket -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='polymarket'"
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL database lookup failed; local services are not ready.' }
  if ($exists -ne '1') {
    & (Join-Path $pgBin 'createdb.exe') -h 127.0.0.1 -p 5433 -U polymarket polymarket
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL database creation failed; local services are not ready.' }
  }
} finally { $env:PGPASSWORD = $previousPgPassword }
Write-Output 'Local services ready: PostgreSQL 5433, Redis 6380. Run pnpm db:migrate.'
