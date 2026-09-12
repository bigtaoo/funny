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

# Mongo first, on its own: every other service now authenticates as its own least-privilege user
# (server/scripts/mongoDbMap.mjs), and those users have to exist before the services try to connect —
# otherwise they crash-loop on auth failures until the restart policy happens to catch up.
Write-Host ">> Starting mongo + provisioning per-service users ..." -ForegroundColor Cyan
docker compose -f $compose up -d mongo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# mongod accepts connections before it is healthy (the healthcheck also performs rs.initiate); `ping` is one
# of the few commands allowed without authentication, so it is the right thing to wait on here.
$ready = $false
foreach ($i in 1..30) {
  $ping = docker compose -f $compose exec -T mongo mongosh --quiet --eval "db.runCommand({ping:1}).ok" 2>$null
  if ($LASTEXITCODE -eq 0 -and "$ping".Trim() -eq '1') { $ready = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $ready) {
  Write-Host "!! mongod did not accept connections within 60s." -ForegroundColor Red
  docker compose -f $compose logs --tail=40 mongo
  exit 1
}

# Two sessions, in this order, and neither is optional:
#
#  1. Unauthenticated, root only. A data volume created BEFORE auth was turned on holds no users at all, so
#     the compose file's MONGO_INITDB_ROOT_* never ran (the entrypoint only seeds a fresh data dir). Mongo's
#     localhost exception covers exactly this: from inside the container it permits ONE command, createUser
#     on admin — not getUser, so probing first is what fails, not the create. On a volume that already has
#     root this throws Unauthorized and is skipped, which is why it swallows the error.
#  2. Authenticated as root, every service user. The localhost exception is gone the instant root exists, so
#     these cannot ride along in session 1 — that combination silently created nothing.
$bootstrapRoot = @'
try {
  db.getSiblingDB('admin').createUser({ user: 'root', pwd: 'localdev-root', roles: [{ role: 'root', db: 'admin' }] });
  print('bootstrapped root (pre-auth data volume)');
} catch (e) {
  print('root already present (' + e.codeName + ')');
}
'@
$bootstrapRoot | docker compose -f $compose exec -T mongo mongosh --quiet | Out-Null

$provision = node (Join-Path $root '../server/scripts/provisionMongoUsers.mjs') --emit-mongosh --local
if ($LASTEXITCODE -ne 0) { Write-Host "!! could not generate the provisioning script." -ForegroundColor Red; exit 1 }
$out = $provision | docker compose -f $compose exec -T mongo mongosh -u root -p localdev-root --authenticationDatabase admin --quiet
if ($LASTEXITCODE -ne 0) {
  Write-Host "!! provisioning the Mongo users failed:" -ForegroundColor Red
  Write-Host $out
  exit 1
}
Write-Host ("   " + (($out | Select-Object -Last 1) -join ' ')) -ForegroundColor DarkGray

Write-Host ">> Starting full stack ..." -ForegroundColor Cyan
docker compose -f $compose up -d --wait
if ($LASTEXITCODE -ne 0) {
  Write-Host "!! Stack failed to come up (exit $LASTEXITCODE)." -ForegroundColor Red
  Write-Host ""
  Write-Host "Service status:" -ForegroundColor Yellow
  docker compose -f $compose ps
  Write-Host ""
  Write-Host "Unhealthy / exited services:" -ForegroundColor Yellow
  # Show last 40 log lines for any container that isn't running+healthy.
  $bad = docker compose -f $compose ps --format json 2>$null |
         ConvertFrom-Json |
         Where-Object { $_.State -ne 'running' -or $_.Health -eq 'unhealthy' }
  foreach ($svc in $bad) {
    Write-Host ("  -- " + $svc.Service + " (" + $svc.State + "/" + $svc.Health + ") --") -ForegroundColor Red
    docker compose -f $compose logs --tail=40 $svc.Service
    Write-Host ""
  }
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
Write-Host "  logs : docker compose -f docker/docker-compose.local.yml logs -f nginx metaserver worldsvc" -ForegroundColor DarkGray
Write-Host "  stop : ./docker/local-down.ps1   (add -Fresh to wipe data)" -ForegroundColor DarkGray
