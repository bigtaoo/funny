<#
.SYNOPSIS
  Start all Notebook Wars dev server processes, each in its own window with hot reload.

.DESCRIPTION
  - shared: tsc -b --watch (rebuild on shared/src change so dependents restart)
  - meta / gateway / matchsvc / game / commercial (each uses node --watch)
  - presets internal URLs + shared NW_INTERNAL_KEY
  Runs docker compose up -d for Mongo by default.

.EXAMPLE
  npm run dev:all
  npm run dev:all -- -SkipMongo
  npm run dev:all -- -Only meta,commercial
#>
param(
  [switch]$SkipMongo,
  [switch]$SkipShared,
  [string[]]$Only
)

$ErrorActionPreference = 'Stop'
$server = $PSScriptRoot

# Shared secret for all five processes (change in prod; any consistent value in dev)
$internalKey = 'dev-internal-key'

# Per-service log files (JSON lines) live here; the shared logger appends when NW_LOG_DIR is set.
# Each process writes server/logs/<service>.log; readable console output is unaffected.
$logDir = Join-Path $server 'logs'

# name / workspace dir / per-process env vars
# Run node directly (not via npm) so the PowerShell WindowTitle we set is not
# clobbered by nested `npm run` — each window stays titled `nw:<name>`.
$procs = @(
  @{ name = 'meta';       dir = 'metaserver'; env = @{ NW_COMMERCIAL_INTERNAL_URL = 'http://127.0.0.1:18082'; NW_GATEWAY_PUBLIC_WS_URL = 'ws://localhost:8086/gw' } }
  @{ name = 'gateway';    dir = 'gateway';    env = @{ NW_MATCHSVC_INTERNAL_URL  = 'http://127.0.0.1:8091'; NW_GW_PORT = '8086'; NW_META_BASE_URL = 'http://127.0.0.1:18080' } }
  @{ name = 'matchsvc';   dir = 'matchsvc';   env = @{ NW_GATEWAY_INTERNAL_URL   = 'http://127.0.0.1:8090'; NW_GAME_PUBLIC_WS_URL = 'ws://127.0.0.1:8081/ws' } }
  @{ name = 'game';       dir = 'gameserver'; env = @{ NW_MATCHSVC_INTERNAL_URL  = 'http://127.0.0.1:8091' } }
  @{ name = 'commercial'; dir = 'commercial'; env = @{} }
  @{ name = 'admin';      dir = 'admin';      env = @{ NW_GATEWAY_INTERNAL_URL = 'http://127.0.0.1:8090'; NW_MATCHSVC_INTERNAL_URL = 'http://127.0.0.1:8091'; NW_META_BASE_URL = 'http://127.0.0.1:18080'; NW_ADMIN_SEED_USER = 'root'; NW_ADMIN_SEED_PASS = 'rootpass' } }
)

if ($Only) {
  $procs = $procs | Where-Object { $Only -contains $_.name }
  if (-not $procs) { Write-Error "No matching process in -Only: $($Only -join ',')"; exit 1 }
}

function Start-DevWindow([string]$title, [hashtable]$env, [string]$cmd, [string]$dir = $server) {
  # Build inner command for the new window: title -> env -> cd -> run.
  # Set the title last-thing-before-run and avoid nested npm so it is not
  # overwritten — the window stays labeled `nw:<title>`.
  $lines = @("`$env:NW_INTERNAL_KEY = '$internalKey'", "`$env:NW_LOG_DIR = '$logDir'")
  foreach ($k in $env.Keys) { $lines += "`$env:$k = '$($env[$k])'" }
  $lines += "Set-Location -LiteralPath '$dir'"
  $lines += "`$host.UI.RawUI.WindowTitle = 'nw:$title'"
  $lines += $cmd
  $inner = $lines -join '; '
  Start-Process powershell -ArgumentList '-NoExit', '-NoProfile', '-Command', $inner | Out-Null
  Write-Host "  window nw:$title  ->  $cmd"
}

Write-Host "Notebook Wars dev start ($server)" -ForegroundColor Cyan

if (-not $SkipMongo) {
  Write-Host "[1/3] Mongo (docker compose up -d) ..." -ForegroundColor Yellow
  docker compose up -d
} else {
  Write-Host "[1/3] skip Mongo" -ForegroundColor DarkGray
}

if (-not $SkipShared) {
  Write-Host "[2/3] shared watch" -ForegroundColor Yellow
  Start-DevWindow 'shared' @{} 'npx tsc -b shared --watch'
} else {
  Write-Host "[2/3] skip shared watch" -ForegroundColor DarkGray
}

Write-Host "[3/3] service processes" -ForegroundColor Yellow
foreach ($p in $procs) {
  $dir = Join-Path $server $p.dir
  Start-DevWindow $p.name $p.env 'node --watch --import tsx src/index.ts' $dir
}

Write-Host ""
Write-Host "Done. Each process runs in its own window and auto-restarts on code change." -ForegroundColor Green
Write-Host "Close: close each window; stop Mongo: docker compose down" -ForegroundColor DarkGray
