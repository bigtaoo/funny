<#
.SYNOPSIS
  Start the local "production-like" full stack (client + 6 server processes + mongo,
  all in Docker, every request routed through nginx).

.DESCRIPTION
  - Every up runs --build: images are rebuilt from current code, so re-running picks up edits.
  - Entry: http://localhost:8088 (or -Port). -Fresh wipes the DB volume first.
  - Isolated from live edits: processes run from images; editing local code does not affect
    running containers until you re-run (which rebuilds).
  - Default port 8088 (not 80): this machine reserves 80/8080/8082/8083 in the Windows TCP
    excludedportrange (http.sys / WinNAT), so binding them fails with EACCES.

.EXAMPLE
  ./local-up.ps1
  ./local-up.ps1 -Fresh
  ./local-up.ps1 -Port 9000
#>
param(
  [int]$Port = 8088,
  [switch]$Fresh
)
# NOTE: do not set ErrorActionPreference=Stop here — docker writes build progress to stderr,
# which Windows PowerShell 5.1 would otherwise treat as a terminating error. Check $LASTEXITCODE.
$root = $PSScriptRoot
$compose = Join-Path $root 'docker-compose.local.yml'

# Client API/WS URLs are baked at build time and must match nginx's host port,
# so derive them from $Port and pass to compose.
$env:NW_HTTP_PORT   = "$Port"
$env:NW_PUBLIC_API  = "http://localhost:$Port/api"
$env:NW_PUBLIC_GW   = "ws://localhost:$Port/gw"
$env:NW_PUBLIC_GAME = "ws://localhost:$Port/ws"

if ($Fresh) {
  Write-Host ">> Tearing down old stack + data volume ..." -ForegroundColor Yellow
  docker compose -f $compose down -v
}

Write-Host ">> Building and starting full stack (latest code) ..." -ForegroundColor Cyan
docker compose -f $compose up -d --build --wait
if ($LASTEXITCODE -ne 0) {
  Write-Host "!! Stack failed to come up (exit $LASTEXITCODE). Recent logs:" -ForegroundColor Red
  docker compose -f $compose ps
  exit $LASTEXITCODE
}

Write-Host ""
docker compose -f $compose ps
Write-Host ""
Write-Host "OK. Open in browser: http://localhost:$Port" -ForegroundColor Green
Write-Host "  logs : docker compose -f docker-compose.local.yml logs -f nginx metaserver gateway" -ForegroundColor DarkGray
Write-Host "  stop : ./local-down.ps1   (add -Fresh to wipe data)" -ForegroundColor DarkGray
