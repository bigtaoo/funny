<#
.SYNOPSIS
  Start all Notebook Wars dev server processes, each in its own window with hot reload.

.DESCRIPTION
  - shared: tsc -b --watch (rebuild on shared/src change so dependents restart)
  - meta / gateway / matchsvc / game / commercial / world / auction / admin (each uses node --watch)
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
  @{ name = 'meta';       dir = 'metaserver'; env = @{ NW_COMMERCIAL_INTERNAL_URL = 'http://127.0.0.1:18082'; NW_GATEWAY_PUBLIC_WS_URL = 'ws://localhost:8086/gw'; NW_SOCIALSVC_INTERNAL_URL = 'http://127.0.0.1:8085' } }
  @{ name = 'gateway';    dir = 'gateway';    env = @{ NW_MATCHSVC_INTERNAL_URL  = 'http://127.0.0.1:8091'; NW_GW_PORT = '8086'; NW_META_BASE_URL = 'http://127.0.0.1:18080'; NW_GW_REDIS_URL = 'redis://127.0.0.1:6379' } }
  @{ name = 'matchsvc';   dir = 'matchsvc';   env = @{ NW_GATEWAY_INTERNAL_URL   = 'http://127.0.0.1:8090'; NW_GAME_PUBLIC_WS_URL = 'ws://127.0.0.1:8081/ws' } }
  @{ name = 'game';       dir = 'gameserver'; env = @{ NW_MATCHSVC_INTERNAL_URL  = 'http://127.0.0.1:8091' } }
  @{ name = 'commercial'; dir = 'commercial'; env = @{} }
  @{ name = 'social';     dir = 'socialsvc';  env = @{ NW_SOCIAL_PORT = '8085'; NW_GATEWAY_INTERNAL_URL = 'http://127.0.0.1:8090'; NW_META_INTERNAL_URL = 'http://127.0.0.1:18080' } }
  @{ name = 'world';      dir = 'worldsvc';   env = @{ NW_WORLD_PORT = '18084'; NW_GATEWAY_INTERNAL_URL = 'http://127.0.0.1:8090'; NW_SOCIALSVC_INTERNAL_URL = 'http://127.0.0.1:8085'; NW_WORLD_REDIS_URL = 'redis://127.0.0.1:6379' } }
  @{ name = 'auction';    dir = 'auctionsvc'; env = @{ NW_AUCTION_PORT = '18086'; NW_META_INTERNAL_URL = 'http://127.0.0.1:18080'; NW_COMMERCIAL_INTERNAL_URL = 'http://127.0.0.1:18082' } }
  @{ name = 'admin';      dir = 'admin';      env = @{ NW_GATEWAY_INTERNAL_URL = 'http://127.0.0.1:8090'; NW_MATCHSVC_INTERNAL_URL = 'http://127.0.0.1:8091'; NW_META_BASE_URL = 'http://127.0.0.1:18080'; NW_ADMIN_SEED_USER = 'root'; NW_ADMIN_SEED_PASS = 'rootpass'; NW_ANALYTICS_BASE_URL = 'http://127.0.0.1:18085' } }
  @{ name = 'analytics';  dir = 'analyticsvc'; env = @{ NW_ANALYTICS_PORT = '18085' } }
  @{ name = 'botsvc';     dir = 'botsvc';     env = @{ NW_BOT_PORT = '18087'; NW_META_BASE_URL = 'http://127.0.0.1:18080'; NW_SOCIAL_BASE_URL = 'http://127.0.0.1:8085'; NW_WORLD_BASE_URL = 'http://127.0.0.1:18084'; NW_GATEWAY_INTERNAL_URL = 'http://127.0.0.1:8090'; NW_GATEWAY_WS_URL = 'ws://127.0.0.1:8086/gw'; NW_COMMERCIAL_INTERNAL_URL = 'http://127.0.0.1:18082' } }
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

# ── Health-check summary ──────────────────────────────────────────────────────
# Wait for processes to start, then ping every /health endpoint.
# Skipped when -Only is used (only a subset of services was started).
if (-not $Only) {
  Write-Host ""
  Write-Host "Waiting for services to start..." -ForegroundColor Yellow
  Start-Sleep -Seconds 6

  # service name → health URL (uses each service's default dev port)
  $checks = [ordered]@{
    meta       = 'http://127.0.0.1:18080/health'
    gateway    = 'http://127.0.0.1:8090/health'   # internal listener
    matchsvc   = 'http://127.0.0.1:8091/health'   # internal listener
    game       = 'http://127.0.0.1:8081/health'
    commercial = 'http://127.0.0.1:18082/health'
    social     = 'http://127.0.0.1:8085/health'
    world      = 'http://127.0.0.1:18084/health'
    auction    = 'http://127.0.0.1:18086/health'
    admin      = 'http://127.0.0.1:18083/health'
    analytics  = 'http://127.0.0.1:18085/health'
    botsvc     = 'http://127.0.0.1:18087/health'
  }

  $anyDown = $false
  Write-Host ""
  Write-Host "  Service          Status   URL" -ForegroundColor Cyan
  Write-Host "  ───────────────────────────────────────────────────────────────" -ForegroundColor DarkGray
  foreach ($svc in $checks.Keys) {
    $url = $checks[$svc]
    $ok  = $false
    try {
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
      $ok = ($r.StatusCode -eq 200)
    } catch { $ok = $false }

    $pad  = ' ' * (16 - $svc.Length)
    if ($ok) {
      Write-Host ("  " + $svc + $pad + "  OK       " + $url) -ForegroundColor Green
    } else {
      Write-Host ("  " + $svc + $pad + "  DOWN  !! " + $url) -ForegroundColor Red
      $anyDown = $true
    }
  }
  Write-Host ""
  if ($anyDown) {
    Write-Host "  !! One or more services are not yet up." -ForegroundColor Red
    Write-Host "     They may still be compiling. Re-run 'npm run dev:health' in ~10s to recheck." -ForegroundColor DarkGray
  } else {
    Write-Host "  All services healthy." -ForegroundColor Green
  }
  Write-Host ""
}
