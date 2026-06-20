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

# 串行构建各镜像（不并行）：并行 build 会让 5 个 npm ci 同时抢慢速 npm registry，
# 触发 ECONNRESET / EIDLETIMEOUT。逐个构建即可稳定。镜像：
#   nw-server:local（7 个服务端进程共用，构建一次）/ nw-client:local（nginx）/ animator / level-editor / ops。
$buildTargets = @('metaserver', 'nginx', 'animator', 'level-editor', 'ops')
foreach ($svc in $buildTargets) {
  Write-Host ">> Building image for '$svc' ..." -ForegroundColor Cyan
  docker compose -f $compose build $svc
  if ($LASTEXITCODE -ne 0) {
    Write-Host "!! Build failed for '$svc' (exit $LASTEXITCODE)." -ForegroundColor Red
    exit $LASTEXITCODE
  }
}

Write-Host ">> Starting full stack ..." -ForegroundColor Cyan
docker compose -f $compose up -d --wait
if ($LASTEXITCODE -ne 0) {
  Write-Host "!! Stack failed to come up (exit $LASTEXITCODE). Recent logs:" -ForegroundColor Red
  docker compose -f $compose ps
  exit $LASTEXITCODE
}

Write-Host ""
docker compose -f $compose ps
Write-Host ""
Write-Host "OK. Full stack is up (9 server processes + 4 frontends)." -ForegroundColor Green
Write-Host ""
Write-Host "  Frontends:" -ForegroundColor Green
Write-Host "    http://localhost:$Port`t主游戏 (SPA + REST + 对战 WS + SLG + 埋点，全部同源)" -ForegroundColor White
Write-Host "    http://localhost:9091`t动画编辑器 (animator)" -ForegroundColor White
Write-Host "    http://localhost:9092`t关卡编辑器 (level-editor)" -ForegroundColor White
Write-Host "    http://localhost:9093`t运维后台 (ops；默认连 admin http://localhost:18083)" -ForegroundColor White
Write-Host ""
Write-Host "  admin 种子账号: admin / admin123  (改 NW_ADMIN_SEED_USER / NW_ADMIN_SEED_PASS)" -ForegroundColor DarkGray
Write-Host "  logs : docker compose -f docker-compose.local.yml logs -f nginx metaserver worldsvc" -ForegroundColor DarkGray
Write-Host "  stop : ./local-down.ps1   (add -Fresh to wipe data)" -ForegroundColor DarkGray
