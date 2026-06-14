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

# name / npm script / per-process env vars
$procs = @(
  @{ name = 'meta';       script = 'dev:meta';       env = @{ NW_COMMERCIAL_INTERNAL_URL = 'http://127.0.0.1:18082' } }
  @{ name = 'gateway';    script = 'dev:gateway';    env = @{ NW_MATCHSVC_INTERNAL_URL  = 'http://127.0.0.1:8091'; NW_GW_PORT = '8085' } }
  @{ name = 'matchsvc';   script = 'dev:matchsvc';   env = @{ NW_GATEWAY_INTERNAL_URL   = 'http://127.0.0.1:8090'; NW_GAME_PUBLIC_WS_URL = 'ws://127.0.0.1:8081/ws' } }
  @{ name = 'game';       script = 'dev:game';       env = @{ NW_MATCHSVC_INTERNAL_URL  = 'http://127.0.0.1:8091' } }
  @{ name = 'commercial'; script = 'dev:commercial'; env = @{} }
)

if ($Only) {
  $procs = $procs | Where-Object { $Only -contains $_.name }
  if (-not $procs) { Write-Error "No matching process in -Only: $($Only -join ',')"; exit 1 }
}

function Start-DevWindow([string]$title, [hashtable]$env, [string]$cmd) {
  # Build inner command for the new window: set env -> cd -> run
  $lines = @("`$host.UI.RawUI.WindowTitle = 'nw:$title'")
  $lines += "`$env:NW_INTERNAL_KEY = '$internalKey'"
  foreach ($k in $env.Keys) { $lines += "`$env:$k = '$($env[$k])'" }
  $lines += "Set-Location -LiteralPath '$server'"
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
  Start-DevWindow $p.name $p.env "npm run $($p.script)"
}

Write-Host ""
Write-Host "Done. Each process runs in its own window and auto-restarts on code change." -ForegroundColor Green
Write-Host "Close: close each window; stop Mongo: docker compose down" -ForegroundColor DarkGray
