#!/usr/bin/env bash
# Start the full stack with one command (C-3 acceptance): mongo + metaserver + gameserver + caddy.
# Usage: in server/, first `cp .env.example .env` and fill in secrets, then `./deploy/up.sh`.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "✗ Missing .env — run first: cp .env.example .env and fill in NW_JWT_SECRET / NW_DOMAIN" >&2
  exit 1
fi

echo "▶ Building and starting full stack..."
docker compose -f docker-compose.prod.yml --env-file .env up -d --build

echo "▶ Waiting for mongo replica set to be ready..."
# depends_on already waits for mongo healthy; printing status here for easier debugging
docker compose -f docker-compose.prod.yml ps

DOMAIN="$(grep -E '^NW_DOMAIN=' .env | cut -d= -f2-)"
DOMAIN="${DOMAIN:-:80}"
echo
echo "✓ Full stack running. Endpoints:"
if [ "$DOMAIN" = ":80" ]; then
  echo "    REST : http://<host>/api/...   (e.g. curl -X POST http://localhost/api/auth/device -H 'content-type: application/json' -d '{\"deviceId\":\"dev-uuid-123\"}')"
  echo "    WS   : ws://<host>/ws?token=<jwt>"
else
  echo "    REST : https://${DOMAIN}/api/...   (Caddy auto-provisions certificate)"
  echo "    WS   : wss://${DOMAIN}/ws?token=<jwt>"
fi
echo "    View logs: docker compose -f docker-compose.prod.yml logs -f metaserver gameserver caddy"
echo "    Stop stack: docker compose -f docker-compose.prod.yml down   (add -v to wipe data)"
