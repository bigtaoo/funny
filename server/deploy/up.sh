#!/usr/bin/env bash
# 一条命令起全栈（C-3 验收）：mongo + metaserver + gameserver + caddy。
# 用法：在 server/ 下先 `cp .env.example .env` 填好密钥，然后 `./deploy/up.sh`。
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "✗ 缺少 .env——先执行：cp .env.example .env 并填写 NW_JWT_SECRET / NW_DOMAIN" >&2
  exit 1
fi

echo "▶ 构建并起全栈…"
docker compose -f docker-compose.prod.yml --env-file .env up -d --build

echo "▶ 等 mongo 副本集就绪…"
# compose 的 depends_on 已等 mongo healthy，这里再打印状态便于排错
docker compose -f docker-compose.prod.yml ps

DOMAIN="$(grep -E '^NW_DOMAIN=' .env | cut -d= -f2-)"
DOMAIN="${DOMAIN:-:80}"
echo
echo "✓ 全栈已起。出口："
if [ "$DOMAIN" = ":80" ]; then
  echo "    REST : http://<host>/api/...   (例: curl -X POST http://localhost/api/auth/device -H 'content-type: application/json' -d '{\"deviceId\":\"dev-uuid-123\"}')"
  echo "    WS   : ws://<host>/ws?token=<jwt>"
else
  echo "    REST : https://${DOMAIN}/api/...   (Caddy 自动签证书)"
  echo "    WS   : wss://${DOMAIN}/ws?token=<jwt>"
fi
echo "    查日志：docker compose -f docker-compose.prod.yml logs -f metaserver gameserver caddy"
echo "    停全栈：docker compose -f docker-compose.prod.yml down   (加 -v 清数据)"
