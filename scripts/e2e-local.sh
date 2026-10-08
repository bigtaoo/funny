#!/usr/bin/env bash
# Replays the `e2e` job of .github/workflows/ci.yml on a dev machine, with the stack's host ports
# moved off the CI defaults (18080 / 8086 / 8081 / 18084 / 18085 / 18088) so it can run next to whatever
# already owns those ports. Same compose files, same service list, same test commands and
# per-step env as the workflow; the only differences are the port/container-name env vars that
# server/docker-compose.ci.yml reads, and a dedicated compose project so `down -v` can only ever
# remove this stack.
#
# KEEP IN STEP WITH ci.yml's `e2e` job: when a step is added/changed there, change it here too.
#
# Usage (Git Bash on Windows, or any POSIX shell), from anywhere inside the repo:
#   scripts/e2e-local.sh                  # npm ci + full job
#   scripts/e2e-local.sh --skip-install   # client/node_modules already present (see warning below)
#   scripts/e2e-local.sh --keep           # leave the stack up afterwards (tear down yourself)
#
# Env (all optional):
#   NW_E2E_META_PORT=28080  NW_E2E_GATEWAY_PORT=28086  NW_E2E_GAME_PORT=28081
#   NW_E2E_WORLD_PORT=28084 NW_E2E_ANALYTICS_PORT=28085
#   NW_E2E_PROXY_PORT=28088                host ports (CI uses the compose defaults); the last is caddy,
#                                          which client/playwright.config.ts reads too
#   NW_E2E_PROJECT=nw-e2e-local            compose project name; also the redis/mongo/caddy container-name prefix
#   NW_E2E_LOG_DIR=<dir>                   where each step's output goes (default: a fresh temp dir)
#
# Warning: `npm ci` deletes client/node_modules first. In a worktree whose client/node_modules is a
# junction to another checkout, that deletes the OTHER checkout's packages — use --skip-install there.
#
# Exit code: 0 when every step passed — the browser smoke included, which is a hard gate in CI too.

set -uo pipefail

SKIP_INSTALL=0
KEEP=0
for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=1 ;;
    --keep) KEEP=1 ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$ROOT/server"
CLIENT="$ROOT/client"

export NW_E2E_META_PORT="${NW_E2E_META_PORT:-28080}"
export NW_E2E_GATEWAY_PORT="${NW_E2E_GATEWAY_PORT:-28086}"
export NW_E2E_GAME_PORT="${NW_E2E_GAME_PORT:-28081}"
export NW_E2E_WORLD_PORT="${NW_E2E_WORLD_PORT:-28084}"
export NW_E2E_ANALYTICS_PORT="${NW_E2E_ANALYTICS_PORT:-28085}"
export NW_E2E_PROXY_PORT="${NW_E2E_PROXY_PORT:-28088}"
PROJECT="${NW_E2E_PROJECT:-nw-e2e-local}"
export NW_E2E_CONTAINER_PREFIX="$PROJECT"
LOG_DIR="${NW_E2E_LOG_DIR:-$(mktemp -d -t nw-e2e-local.XXXXXX)}"
mkdir -p "$LOG_DIR"

# Job-level env of the workflow, plus CI=true which GitHub Actions sets on every step (Playwright
# reads it for retries/reporter/reuseExistingServer).
export CI=true
export NW_JWT_SECRET=ci-jwt-secret
export NW_INTERNAL_KEY=ci-internal-key
export NW_ADMIN_JWT_SECRET=ci-admin-jwt-secret

API_BASE="http://localhost:$NW_E2E_META_PORT"
GATEWAY_WS="ws://localhost:$NW_E2E_GATEWAY_PORT/gw"

COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.prod.yml -f docker-compose.ci.yml)
SERVICES=(redis mongo metaserver commercial gateway matchsvc gameserver worldsvc analyticsvc auctionsvc caddy)

declare -a SUMMARY=()
HARD_FAIL=0

# step <name> <logfile> <dir> <cmd...>: runs one workflow step, output only to its log file.
step() {
  local name="$1" log="$2" dir="$3"; shift 3
  echo ">> $name  (log: $LOG_DIR/$log)"
  ( cd "$dir" && "$@" ) > "$LOG_DIR/$log" 2>&1
  local rc=$?
  SUMMARY+=("$(printf '%-44s %s' "$name" "$([ $rc -eq 0 ] && echo ok || echo "FAILED (exit $rc)")")")
  return $rc
}

teardown() {
  if [ "$HARD_FAIL" -ne 0 ]; then
    echo ">> dump server logs on failure  (log: $LOG_DIR/server-logs.txt)"
    ( cd "$SERVER" && "${COMPOSE[@]}" logs --no-color --tail=400 ) > "$LOG_DIR/server-logs.txt" 2>&1
  fi
  if [ "$KEEP" -eq 1 ]; then
    echo ">> --keep: stack left up. Tear down with:"
    echo "   (cd server && docker compose -p $PROJECT -f docker-compose.prod.yml -f docker-compose.ci.yml down -v)"
  else
    echo ">> tear down server stack"
    ( cd "$SERVER" && "${COMPOSE[@]}" down -v ) > "$LOG_DIR/teardown.txt" 2>&1
  fi
  echo
  echo "== summary (project $PROJECT, logs in $LOG_DIR)"
  printf '   %s\n' "${SUMMARY[@]}"
}

# Pre-flight: every host port this run needs must be bindable, including Playwright's dev server
# (9096, fixed in client/playwright.config.ts; with CI=true it refuses to reuse a running one).
busy=()
for p in "$NW_E2E_META_PORT" "$NW_E2E_GATEWAY_PORT" "$NW_E2E_GAME_PORT" "$NW_E2E_WORLD_PORT" "$NW_E2E_ANALYTICS_PORT" "$NW_E2E_PROXY_PORT" 9096; do
  node -e 'const s=require("net").createServer();s.once("error",()=>process.exit(1));s.listen(+process.argv[1],"0.0.0.0",()=>s.close(()=>process.exit(0)))' "$p" || busy+=("$p")
done
if [ "${#busy[@]}" -gt 0 ]; then
  echo "host port(s) not bindable: ${busy[*]} — pick others via NW_E2E_*_PORT (see header)." >&2
  exit 2
fi

trap teardown EXIT

run_job() {
  if [ "$SKIP_INSTALL" -eq 0 ]; then
    step "client install" install.txt "$CLIENT" npm ci || return 1
  fi
  # ci.yml installs chromium before joining the stack it started in the background; here the
  # bring-up simply runs in the foreground, same steps in the same order.
  step "install Playwright chromium" playwright-install.txt "$CLIENT" \
    npx playwright install --with-deps chromium || return 1
  step "bring up server stack" compose-up.txt "$SERVER" \
    "${COMPOSE[@]}" up -d --build --wait "${SERVICES[@]}" || return 1
  step "worldsvc health smoke" health-world.txt "$ROOT" \
    curl -fsS "http://localhost:$NW_E2E_WORLD_PORT/health" || return 1
  step "analyticsvc health smoke" health-analytics.txt "$ROOT" \
    curl -fsS "http://localhost:$NW_E2E_ANALYTICS_PORT/health" || return 1
  step "run full-link E2E" test-e2e.txt "$CLIENT" \
    env NW_API_BASE="$API_BASE" NW_EXPECT_GATEWAY="$GATEWAY_WS" npm run test:e2e || return 1
  step "run ranked load smoke (small fleet)" test-load.txt "$CLIENT" \
    env NW_API_BASE="$API_BASE" NW_LOAD_CLIENTS=20 npm run test:load || return 1
  # ci.yml passes no env here, and neither does this: client/playwright.config.ts builds the bundle
  # against caddy's origin on NW_E2E_PROXY_PORT (exported above; unset in CI = the compose default).
  if ! step "run browser smoke (two-account, real WebGL)" test-browser.txt "$CLIENT" npm run test:browser; then
    echo "   browser smoke failed; report: $CLIENT/playwright-report/"
    return 1
  fi
  return 0
}

run_job || HARD_FAIL=1
exit "$HARD_FAIL"
