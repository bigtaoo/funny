# Server Logs and Observability

## Current Strategy (Phase 1, live)

All five processes (meta / gateway / matchsvc / game / commercial) output via `@nw/shared`'s
`createLogger(service)`, **dual sink**:

- **Console**: readable single-line `12:03:45.678 INFO [gateway] msg key=val`, viewable directly in the process window during development.
- **File**: one JSON object per line, **only enabled when the `NW_LOG_DIR` environment variable is set**, one file per root service name
  `${NW_LOG_DIR}/<service>.log` (`gateway` / `gateway:internal` / `gateway:matchsvc` all write to `gateway.log`).

```jsonc
{"t":"2026-06-14T15:57:10.555Z","level":"info","svc":"gateway","msg":"WS connected","accountId":"abc","online":1}
```

Fields: `t` (ISO8601), `level`, `svc` (including sub-tags), `msg`, rest is structured data for that entry.

### Enabling

- **dev (`npm run dev:all` / `dev-up.ps1`)**: script automatically sets `NW_LOG_DIR` to `server/logs`,
  each process writes to `server/logs/<service>.log` (`*.log` is in .gitignore, not committed).
- **pm2 / Docker**: process stdout is already persisted by their respective runners (`~/.pm2/logs/*`, Docker `json-file`);
  inject `NW_LOG_DIR` into the container/process if additional JSON files are needed.
- **Log level**: `NW_LOG_LEVEL=debug|info|warn|error` (default `debug`).

### Debugging Reference (match pipeline end-to-end)

One ranked game spans gateway → matchsvc → game → meta. Grep by timeline:

```bash
# Who connected to gateway / whether "same account displaced" (classic pitfall of two tabs sharing a device id)
grep -E "WS connected|replacing existing" server/logs/gateway.log
# Enqueue / pairing / game start / GAME_UNAVAILABLE
grep -E "enqueue|pair matched|match starting|GAME_UNAVAILABLE" server/logs/matchsvc.log
# Cross-service HTTP failures (previously silently swallowed)
grep -i "failed\|non-OK" server/logs/*.log
```

## Phase 2 (live): Loki + Alloy + Grafana + cloudflared

Grafana itself does not store logs — the standard stack is **Loki** (storage) + **collector** (Alloy) + **Grafana** (querying).
This stack is in this directory, **decoupled and independently started/stopped** from the main stack (`docker-compose.cloud.yml`):

| File | Purpose |
|---|---|
| `docker-compose.obs.yml` | 4 containers: loki / alloy / grafana / cloudflared |
| `loki/config.yml` | Loki single-process + local storage, 14-day retention |
| `alloy/config.alloy` | Alloy captures all container stdout via docker socket, parses svc/level labels |
| `grafana/provisioning/` | Auto-registers Loki data source + loads dashboards (works out of the box) |
| `grafana/dashboards/server-logs.json` | Starter dashboard "Server Logs" (svc/level/keyword filter + error count + rate) |
| `.env.example` | Grafana password / CF tunnel token (copy to `.env`) |

### Collection: capturing docker stdout (no file volumes)

**Does not use the Phase 1 JSON file approach**. Instead, Alloy captures **all container stdout** directly via docker socket
(`loki.source.docker`). Rationale:

- **Zero intrusion**: no need to set `NW_LOG_DIR` on 9 business processes, no log volume mounts, no main stack compose changes.
- **`docker logs` stays readable**: SSH `docker compose logs -f metaserver` still shows human-readable single-lines.
- **Rotation via docker**: configure `/etc/docker/daemon.json` `log-opts max-size` (see below),
  unlike the file approach which grows indefinitely and needs logrotate.

Trade-off: labels come from regex-parsing readable single-lines (`15:57 INFO [gateway] msg …`), not full-precision JSON.
Alloy uses regex to extract `svc` (root service name, before colon) / `level` as labels; `key=val` pairs in the line (including `roomId`)
**are not put in labels** (high cardinality would bloat Loki), parse with `| logfmt` at query time. Timestamp uses docker's full-precision time.

### Phase 2 Deployment (VPS, one-time)

**Step 0 — Limit docker log volume** (prevent stdout from filling the 40G disk; applies to all containers):
```bash
cat >/etc/docker/daemon.json <<'EOF'
{ "log-driver": "json-file", "log-opts": { "max-size": "50m", "max-file": "5" } }
EOF
systemctl restart docker
# Restarting docker rebuilds containers, main stack restarts with it; confirm full stack is Up:
cd /root/funny/server && docker compose -f docker-compose.cloud.yml --env-file .env up -d
```

**Step 1 — Configure obs `.env`**:
```bash
cd /root/funny/server/observability
cp .env.example .env
# Fill in GF_ADMIN_PASSWORD=$(openssl rand -hex 16); CF_TUNNEL_TOKEN to be filled in after Step 3
```

**Step 2 — Start observability stack** (from `server/` directory; default excludes cloudflared, zero-downtime log viewing):
```bash
cd /root/funny/server
docker compose -f observability/docker-compose.obs.yml --env-file observability/.env up -d
# loki/alloy/grafana are now up. SSH tunnel first: ssh -L 3000:localhost:3000 → http://localhost:3000
```

**Step 3 — Cloudflare Tunnel + Access** (console, ~5 minutes, same "go through Cloudflare" choice as ops):
1. dash.cloudflare.com → **Zero Trust → Networks → Tunnels → Create a tunnel** (Cloudflared type).
   Name it e.g. `nivara-grafana` → **copy the Tunnel token** (`eyJ...` long string) and fill it into `observability/.env` as
   `CF_TUNNEL_TOKEN`, then start the tunnel (`--profile tunnel` enables cloudflared):
   ```bash
   docker compose -f observability/docker-compose.obs.yml --env-file observability/.env --profile tunnel up -d
   ```
2. Same tunnel page **Public Hostnames → Add**: subdomain `grafana`, domain `gamestao.com`,
   Service `HTTP` → `grafana:3000` (cloudflared and grafana share the compose network, resolved by service name).
   CF automatically creates `grafana.gamestao.com` DNS (orange cloud) + edge certificate.
3. **Zero Trust → Access → Applications → Add → Self-hosted**:
   - Name `grafana`, Public hostname `grafana.gamestao.com` (path empty = covers whole site).
   - Add policy: Action **Allow** → Include → **Emails** list authorized emails (e.g. `tao.wang@elk.de`).
   Login method reuses the One-time PIN already configured for ops.

**Step 4 — Verify**: open `https://grafana.gamestao.com` in browser → CF Access email verification code →
Grafana login page (admin / password in `.env`) → left bar "Dashboards → Notebook Wars → Server Logs" shows live logs.

> **SSH fallback (works without CF)**: Grafana binds `127.0.0.1:3000`. On your machine run
> `ssh -i ~/.ssh/nivara_hetzner -L 3000:localhost:3000 root@128.140.41.98`, open `http://localhost:3000`.
> In this case comment out the `cloudflared` service and leave `CF_TUNNEL_TOKEN` empty.

### Grafana Log Queries (LogQL quick reference)

```logql
{svc="matchsvc"}                         # All logs for a service
{svc=~"gateway|matchsvc", level="error"} # Multiple services + errors only
{svc="matchsvc"} |= "GAME_UNAVAILABLE"   # Substring filter
{} | logfmt | roomId="<id>"              # Pull one game session across all processes into a timeline (see "Cross-process correlation" below)
{service="nw-caddy"}                      # Non-business containers: filter by compose service name / container name
```

The "Server Logs" dashboard has `Service / Level / Keyword` dropdowns/inputs at the top — no need to type LogQL manually.

### Liveness Heartbeat (heartbeat, live)

8 business processes call `@nw/shared`'s `startHeartbeat(log)` on startup (`shared/src/heartbeat.ts`): **even when idle, an `info`-level `heartbeat` log is emitted every 5 minutes** (with `uptimeSec` / `rssMb`) as a positive signal that "the process is alive + the collection pipeline is working".
Even with no players and no business logs, Grafana shows each svc pulsing on schedule.

```logql
{svc="meta"} |= "heartbeat"                                  # View heartbeats for a service
sum by (svc) (count_over_time({svc=~".+"} |= "heartbeat" [5m]))  # Heartbeat count per service (should be ≥1; gap = possibly down)
```

The "**Service Liveness**" panel at the top of the dashboard uses the query above: one line per svc; dropping to 0 or breaking means that process is not heartbeating.
Heartbeat is `info` level, so it won't be filtered out even with `NW_LOG_LEVEL=info` in production. Interval/fields are configurable in `startHeartbeat`.

### Cross-process Correlation (correlation id, live)

One game session spans multiple processes. **`roomId`** is used as correlation id across gateway→matchsvc→game→meta:

- matchsvc: room creation/join/game start/match starting logs all include `roomId`;
- matchsvc→gateway `/gw/push` request body carries `roomId` (for logging only, not included in client-visible PushMsg),
  gateway's `push -> room_state|match_found` log prints `roomId` from this;
- game: handshake/join logs include `roomId` (from ticket);
- meta: `POST /internal/match/report` includes `room_id`.

Once Grafana is connected to Loki, `{} | logfmt | roomId="<id>"` pulls the entire game into one timeline
(`logfmt` parses the `key=val` tail of readable single-lines; switch to `| json` if moving back to JSON file approach later).

> Note: gateway **inbound** commands (room_create / enqueue) have no `roomId` before the room is created; correlate by `accountId` —
> same accountId's `recv room_create` → matchsvc `recv /mm/room/create` → `room created roomId=…` bridges to the roomId.

## Phase 3 (core loop implemented): Client Log Targeted Collection

Lets operations pull **a single player's** client logs into Loki/Grafana by **9-digit publicId** remotely.
The mechanism goes through feature flags (`client_log_error/warn/info/debug` four tiered switches + `allowPublicIds` targeting dimension);
client polls `GET /bootstrap` every 2 minutes for the matched level, then on match batches logs at or above the threshold from a ring buffer via `POST /client/log`, metaserver forwards to Loki.

- **Full design and implementation record**: `design/game/FEATURE_FLAGS_DESIGN.md` §9 + §8 "2026-06-24 · Client Log Targeted Collection" (authoritative).
- **How to use** (operations): ops "Feature Flags" → select the desired level flag (e.g. `client_log_debug`) → **set gray ratio to 0** + put target 9-digit publicId in **allowPublicIds** → save. Client matches within ≤2 minutes and starts reporting. Grafana left bar "Notebook Wars → Client Logs (Targeted Collection)" panel: fill in publicId to view.
- **⚠ Critical exclusion gotcha**: filling allowPublicIds without setting pct=0 → flag opens for **everyone** (full client reporting, catastrophic). Must use `pct:0` (exclude everyone else) + `allowPublicIds` (allow-list for targeting).
- **Loki ingestion convention**: labels only `{source="client", level=...}` (low cardinality); `publicId` / `tag` / `msg` in **line body** (logfmt); Grafana query: `{source="client"} | logfmt | publicId="<9-digit>"`.
- **⚠ Network gotcha (resolved 2026-06-27)**: the obs stack (`docker-compose.obs.yml`) is a **separate compose / separate network**; main stack metaserver **cannot resolve `loki`** by default. **Previously prod's `NW_LOKI_PUSH_URL` was empty → all client crash / targeted logs silently dropped, Grafana always empty** (identified during §9.7 "iPad crash not recorded" debugging).
  - **Current solution**: obs `loki` service is attached to both its own obs network **+ main stack network `server_default`** (external, alias `nw-loki`), so metaserver pushes directly using `http://nw-loki:3100/loki/api/v1/push`. Default values of `NW_LOKI_PUSH_URL` in both composes (cloud/prod) have been changed to this address (still overridable via `.env`).
  - **Coupling direction**: obs depends on the main stack (`server_default` must exist = main stack runs first), **never the other way** — obs failing to start if main stack is down is acceptable; if obs is down, metaserver fails to resolve `nw-loki` → `pushToLoki` silently drops, **no player impact, no main stack startup impact**.
  - Must also configure `NW_ADMIN_INTERNAL_URL` (**missing it disables flag polling → bootstrap always returns empty map → §9.4 targeted collection never works**; §9.7 full reporting is unaffected).
  - **First debugging step**: `docker exec server-metaserver-1 printenv NW_LOKI_PUSH_URL` should be non-empty. Verify connectivity: `docker exec server-metaserver-1 node -e 'fetch("http://nw-loki:3100/ready").then(r=>r.text()).then(console.log)'`.
- **Grafana panel**: `grafana/dashboards/client-logs.json` (auto-loaded via provisioning).

### Operations Quick Reference

```bash
cd /root/funny/server
# Start / stop / view observability stack logs
docker compose -f observability/docker-compose.obs.yml --env-file observability/.env up -d
docker compose -f observability/docker-compose.obs.yml down
docker compose -f observability/docker-compose.obs.yml logs -f alloy   # Check here first if collector isn't capturing
# Reload after changing alloy/loki config
docker compose -f observability/docker-compose.obs.yml --env-file observability/.env up -d --force-recreate alloy loki
```

> **If full-precision JSON labels are needed in the future** (rather than regex-parsing readable single-lines): set
> `NW_LOG_DIR=/var/log/nw` + shared volume mount on main stack business processes, logger writes JSON files (see Phase 1), then swap
> `alloy/config.alloy` to the `loki.source.file` + `stage.json` approach. The current docker-socket approach is sufficient
> and has no file growth issues; don't switch unless necessary.
