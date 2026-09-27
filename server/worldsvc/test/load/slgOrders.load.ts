// SLG order-throughput load test — "can worldsvc digest 200 players issuing orders in a pitched battle?"
//
// This is the measurement the whole worldsvc-concurrency-2026-09-05 workstream was aimed at and never
// actually took: every number in that audit came from an offline micro-benchmark. It drives NW_LOAD_BOTS
// real REST clients against a LIVE stack — device login, join the season, then a sustained storm of
// `POST /world/march` occupy orders at a per-bot cadence — and reports what came back.
//
// It reads worldsvc's OWN metrics (`GET /admin/world/metrics`) either side of the storm, which is the
// point: from the client side a blocked event loop and a merely busy server look identical (everything is
// slow at once). `loopLagMs.max` is what tells them apart, and it is the number that used to sit at
// 2000-6000ms on a single unreachable-target order.
//
// Two things to know when reading that block. `loopLagMs` covers everything since the heartbeat last
// drained it (up to 5 minutes), not just this run — a superset, so a value under budget is still proof
// the run stayed under budget. And its p50 sits at the histogram's 20ms sampling resolution even on a
// perfectly idle process: read `max`, not `p50`.
//
// ── Why /world/* goes DIRECT to worldsvc by default ───────────────────────────────────────────────────
// Measured 2026-09-05, same fleet, same window, only the route changed:
//
//   through nginx (:8088)      p50 398ms   p90 4407ms   p99 7870ms   max 8945ms
//   direct to worldsvc (:18084) p50  33ms   p90   53ms   p99   98ms   max  115ms
//
// while worldsvc's own `POST /world/march` timing stayed at p50 7ms / p99 17ms in BOTH runs. The seconds
// were spent entirely in front of the service: `client/nginx.conf` sets `proxy_http_version 1.1` but
// declares no `upstream { keepalive }`, so every proxied request opens a fresh TCP connection to the
// upstream, and at ~80 requests/s that queue is what a client sees. It is a local-stack artifact —
// production fronts worldsvc with Caddy (`server/Caddyfile`), which pools upstream connections — so
// routing around it here measures the thing this test is for. Set NW_LOAD_WORLD_BASE to the nginx base
// to measure the proxy instead; that is a real (separate) question, just not this test's.
//
// ── Running it ────────────────────────────────────────────────────────────────────────────────────────
//   1. Bring the stack up (from the repo root):
//        docker compose -f docker/docker-compose.local.yml up -d
//      If worldsvc has changed since the image was built, rebuild just it:
//        docker compose -f docker/docker-compose.local.yml up -d --build worldsvc
//   2. Run:
//        npm run test:load -w @nw/worldsvc
//
// ── Knobs (all env) ───────────────────────────────────────────────────────────────────────────────────
//   NW_LOAD_BASE          public base URL (nginx)              default http://localhost:8088
//   NW_LOAD_METRICS_BASE  worldsvc direct, for its own metrics  default http://localhost:18084
//   NW_LOAD_WORLD_BASE    where /world/* goes                   default http://localhost:18084 (direct)
//   NW_LOAD_BOTS          fleet size                           default 200
//   NW_LOAD_ORDER_MS      per-bot interval between orders      default 2500  (the "2-3s in a fight" figure)
//   NW_LOAD_WINDOW_MS     how long the storm runs              default 30000
//   NW_LOAD_LOGIN_CONC    concurrent logins during ramp-up     default 25
//   NW_LOAD_MIN_OK_PCT    min % of orders that must be accepted default 90
//   NW_LOAD_P99_MS        dispatch-latency p99 budget          default 2000
//   NW_LOAD_LOOP_MS       worldsvc event-loop stall budget     default 500
//   NW_LOAD_ARRIVALS_P50_MS  typical arrival-tick budget        default 200   (pre-batching p50 was 1761)
//   NW_LOAD_FLEET_ID      device-id prefix; a fresh one per run default a timestamp (see below)
//   NW_INTERNAL_KEY       X-Internal-Key for /admin/world/metrics  default dev-internal-key (the local stack's)
//
// The metrics read goes DIRECT to worldsvc, not through nginx: `/admin/world/*` is internal-only and
// nginx deliberately does not proxy it, so docker-compose.local.yml publishes 18084 for this (local
// only — see the comment there).
//
// A bot's troop pool is 5000 and an occupy costs OCCUPY_MIN_TROOPS (500), so each bot can issue ~10
// orders before it legitimately runs out — that is the game's economy, not a defect. NO_TROOPS is
// therefore counted separately from real failures and does not count against the success rate.
//
// ── One dedicated world per run (2026-09-26, ADR-092 / audit §12.7 phase 0) ──────────────────────────
// Until 2026-09-26 every run joined the SAME season world and state accumulated run over run (§6.6b:
// `POST /world/march` p50 7.5ms → 122.8ms across three runs of identical code). Each run now opens its
// own world in a season nothing else uses (see ./loadWorld.ts for why a fresh shard is not enough),
// waits for the previous run's leftovers to stop generating work, and closes its world when done. Fleet
// size is now the only variable, which is what the 500 → 1000 → 2000 → 3000 ladder needs.
//
// Each run still takes a FRESH device-id prefix by default. Device login is idempotent per deviceId, so a
// fixed prefix means the second run inherits the first run's accounts: the very first execution of this
// test measured 200 bots, and the next one measured 200 bots answering NO_TROOPS in 5ms — a much
// prettier latency number describing nothing. Set NW_LOAD_FLEET_ID to reuse a fleet deliberately.
//
// ── Two load models ───────────────────────────────────────────────────────────────────────────────────
//   storm  (default) every bot fires an occupy every NW_LOAD_ORDER_MS (2500) — the "pitched battle" upper
//          bound. At 3000 bots that is 1200 orders/s, far above anything real players produce: read it as
//          a ceiling probe, not a forecast.
//   paced  per bot, exponential gaps with mean NW_LOAD_ORDER_MS (default 30000 in this mode), each order
//          followed by the `GET /world/orders` the client issues when its march_update push lands
//          (refreshMarches), plus a `GET /world/map` (r=20, a zoom-1 viewport) with mean gap
//          NW_LOAD_MAP_MS (default 20000). The cadences are ASSUMPTIONS, not measured player behaviour —
//          they are knobs so a better estimate can be plugged in without touching the code.
//
// ── Knobs added 2026-09-26 ────────────────────────────────────────────────────────────────────────────
//   NW_LOAD_MODEL          storm | paced                                     default storm
//   NW_LOAD_MAP_MS         mean gap between map reads per bot (0 = none)     default 0 storm / 20000 paced
//   NW_LOAD_CAPACITY       capacity of the run's world                       default 10000
//   NW_LOAD_QUIET_OPS      Mongo ops/s under which the server counts as idle default 30
//   NW_LOAD_QUIESCE_MS     longest wait for leftovers to settle              default 600000
//   NW_LOAD_KEEP_WORLD     1 = leave the run's world open afterwards         default unset
//   NW_LOAD_REPORT_FILE    append the run's summary as one JSON line here    default unset
//
// ── Reading the ladder ────────────────────────────────────────────────────────────────────────────────
// Four walls, four numbers (audit §12.7):
//   Mongo ops/s    local mongod has no quota, so the run COUNTS commands (driver command monitoring) and
//                  prints the rate next to Atlas M0's 100 ops/s ceiling (§9). Includes the idle baseline.
//   compute        `compute:siege:run` = one battle on a worker; `:wait` = time queued for a free worker.
//                  Prod has ONE worker (2 vCPU). Set NW_COMPUTE_POOL_SIZE=1 on the local worldsvc to
//                  match it — the local 22-core box otherwise gets 8 and hides this wall.
//   settlement     `arrivals.deferred` growing during the window = settlement throughput is the ceiling.
//   push fan-out   pushes/s and `vision:observers` (one Mongo query per tile push).
import { appendFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  proceduralTile,
  OCCUPY_MIN_TROOPS,
  SLG_MAP_W,
  SLG_MAP_H,
  runBounded,
} from '@nw/shared';
import { AdminClient, provisionLoadWorld, waitForQuiet, counterRates, labelCount, eluBetween, type MetricsSnapshot } from './loadWorld';

const BASE = process.env.NW_LOAD_BASE ?? 'http://localhost:8088';
const METRICS_BASE = process.env.NW_LOAD_METRICS_BASE ?? 'http://localhost:18084';
const WORLD_BASE = process.env.NW_LOAD_WORLD_BASE ?? METRICS_BASE;
const BOTS = Number(process.env.NW_LOAD_BOTS ?? 200);
const MODEL: 'storm' | 'paced' = process.env.NW_LOAD_MODEL === 'paced' ? 'paced' : 'storm';
const ORDER_MS = Number(process.env.NW_LOAD_ORDER_MS ?? (MODEL === 'paced' ? 30_000 : 2500));
const MAP_MS = Number(process.env.NW_LOAD_MAP_MS ?? (MODEL === 'paced' ? 20_000 : 0));
const CAPACITY = Number(process.env.NW_LOAD_CAPACITY ?? 10_000);
const QUIET_OPS = Number(process.env.NW_LOAD_QUIET_OPS ?? 30);
const QUIESCE_MS = Number(process.env.NW_LOAD_QUIESCE_MS ?? 600_000);
const KEEP_WORLD = process.env.NW_LOAD_KEEP_WORLD === '1';
const REPORT_FILE = process.env.NW_LOAD_REPORT_FILE;
/** Atlas M0's shared-tier throttle (audit §9) — printed next to the counted rate, not asserted. */
const ATLAS_M0_OPS_PER_SEC = 100;
const WINDOW_MS = Number(process.env.NW_LOAD_WINDOW_MS ?? 30_000);
const LOGIN_CONC = Number(process.env.NW_LOAD_LOGIN_CONC ?? 25);
const MIN_OK_PCT = Number(process.env.NW_LOAD_MIN_OK_PCT ?? 90);
const P99_BUDGET_MS = Number(process.env.NW_LOAD_P99_MS ?? 2000);
const LOOP_BUDGET_MS = Number(process.env.NW_LOAD_LOOP_MS ?? 500);
/**
 * Budget for a TYPICAL arrival tick, and deliberately not for the tail.
 *
 * Measured 2026-09-05, same fleet, same storm, before and after the deep batching:
 *
 *   before   p50 1761ms   p90 6705ms   30 interval-overrun warnings
 *   after    p50  2-7ms   p90 61-4091ms   3-6 warnings
 *
 * p50 is the number the batching owns and it moved by three orders of magnitude. The tail did not follow,
 * and the split counter says why: of ~2600 marches handled in a 32s storm, ~1100 were ARRIVING, and an
 * arriving march runs a real occupation battle through the compute pool plus a metaserver round trip. Those
 * cluster into a few ticks and cost seconds there. That is a different problem with a different fix (spread
 * the settlements, not batch them) and it is recorded as the next lever, not silently absorbed here.
 *
 * So the assertion is on p50, with a budget an order of magnitude under the pre-batching p50 — a regression
 * that puts the per-march stepping loop back lands at ~1700ms and fails this loudly. p90/max/the split are
 * printed rather than asserted: they are currently dominated by settlement bursts, so a budget on them would
 * be a budget on work this test cannot attribute.
 */
const ARRIVALS_P50_BUDGET_MS = Number(process.env.NW_LOAD_ARRIVALS_P50_MS ?? 200);
const INTERNAL_KEY = process.env.NW_INTERNAL_KEY ?? 'dev-internal-key';
const FLEET_ID = process.env.NW_LOAD_FLEET_ID ?? Date.now().toString(36);

interface Bot {
  id: number;
  token: string;
  worldId: string;
  base: { x: number; y: number };
  /** Candidate occupy targets, pre-filtered client-side; consumed in order. */
  targets: { x: number; y: number }[];
  nextTargetIdx: number;
}

interface OrderOutcome {
  ms: number;
  ok: boolean;
  /** Server error code/message for a rejected order, or null when accepted. */
  reason: string | null;
}

async function api<T>(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<T> {
  const origin = path.startsWith('/world') ? WORLD_BASE : BASE;
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  // The envelope's `error` is an OBJECT ({code, message}) — `@nw/shared`'s err(). Stringifying it
  // naively is how the first run of this test reported 427 rejections as `{"[object Object]": 427}`,
  // which told us a fifth of the orders failed and nothing about why.
  const parsed = (await res.json()) as { ok: boolean; data?: T; error?: { code?: string; message?: string } | string };
  if (!parsed.ok) {
    const e = parsed.error;
    const code = typeof e === 'string' ? e : (e?.code ?? e?.message ?? `HTTP ${res.status}`);
    throw new Error(code);
  }
  return parsed.data as T;
}

/** Ordinary ground a march may occupy — no city, choke, obstacle or the world centre. */
function isOccupiable(worldId: string, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= SLG_MAP_W || y >= SLG_MAP_H) return false;
  const t = proceduralTile(worldId, x, y).type;
  return t !== 'obstacle' && t !== 'center' && t !== 'familyKeep' && t !== 'stronghold' && t !== 'bridge' && t !== 'plankway';
}

/**
 * Occupy targets for a bot: the ring just outside its 3x3 capital footprint.
 *
 * Distance 2 specifically — distance 1 is the footprint itself (already the player's territory, so the
 * server answers "use reinforce"), and anything further would fail ADR-039's connectivity rule until an
 * earlier occupy has actually landed. Occupation is not instant (§5.4 gives it a 5-minute hold), so
 * within one load window every order has to be adjacent to the footprint the bot started with.
 */
function ringTargets(worldId: string, base: { x: number; y: number }): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== 2) continue;
      const x = base.x + dx, y = base.y + dy;
      // Must touch the footprint orthogonally, or ADR-039 refuses it.
      const touches = (Math.abs(dx) === 2 && Math.abs(dy) <= 1) || (Math.abs(dy) === 2 && Math.abs(dx) <= 1);
      if (!touches || !isOccupiable(worldId, x, y)) continue;
      out.push({ x, y });
    }
  }
  return out;
}

function parseTile(tileId: string): { x: number; y: number } | null {
  const parts = tileId.split(':');
  if (parts.length < 3) return null;
  const y = Number(parts[parts.length - 1]), x = Number(parts[parts.length - 2]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!);
}

/** Request kinds reported separately, so march / orders / map latencies never blur into one number. */
type ReadKind = 'orders' | 'map';

/** Exponential gap with the given mean — independent players, not a synchronised fleet. */
function expGap(meanMs: number): number {
  return -Math.log(1 - Math.random()) * meanMs;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function latencyLine(xs: number[]): string {
  const s = [...xs].sort((a, b) => a - b);
  return `n ${s.length}  p50 ${pct(s, 0.5)}ms  p90 ${pct(s, 0.9)}ms  p99 ${pct(s, 0.99)}ms  max ${s.at(-1) ?? 0}ms`;
}

function labelLine(m: MetricsSnapshot, label: string): string {
  const l = m.labels?.[label];
  return l ? `p50 ${l.p50}ms  p90 ${l.p90}ms  p99 ${l.p99}ms  max ${l.max}ms` : '-';
}

describe('worldsvc SLG order throughput', () => {
  it(`digests ${BOTS} bots (${MODEL}, one order per ${ORDER_MS}ms${MODEL === 'paced' ? ' mean' : ''})`, async () => {
    /* eslint-disable no-console */
    const log = (line: string): void => console.log(line);
    const admin = new AdminClient(METRICS_BASE, INTERNAL_KEY);

    // Fail loudly rather than "0 bots, 100% success" if the stack is not up — a load test that passes
    // against nothing is worse than one that errors.
    await admin.listWorlds();
    const idleOps = await waitForQuiet(admin, QUIET_OPS, QUIESCE_MS, log);
    const { worldId: loadWorld, season } = await provisionLoadWorld(admin, CAPACITY);
    log(`[load] world ${loadWorld} (season ${season}, capacity ${CAPACITY}) | model ${MODEL} | bots ${BOTS} | idle baseline ${idleOps?.toFixed(1) ?? '-'} Mongo ops/s`);

    try {
      // ── Ramp: device login + join the load season, bounded so the ramp itself is not the bottleneck ──
      const bots: Bot[] = [];
      const rampErrors: string[] = [];
      let strayJoins = 0;
      const ids = Array.from({ length: BOTS }, (_, i) => i);
      const rampStart = Date.now();
      await runBounded(ids, LOGIN_CONC, async (i) => {
        try {
          const login = await api<{ token: string }>('POST', '/api/auth/device', {
            body: { deviceId: `loadbot-${FLEET_ID}-${i}` },
          });
          const me = await api<{ worldId?: string; mainBaseTile?: string }>('POST', '/world/season/join', {
            token: login.token,
            body: { season },
          });
          const base = me.mainBaseTile ? parseTile(me.mainBaseTile) : null;
          if (!me.worldId || !base) throw new Error('joined without a base');
          // Only one world is open in the load season, so anything else means join routing changed under us.
          if (me.worldId !== loadWorld) {
            strayJoins++;
            throw new Error(`joined ${me.worldId}, not ${loadWorld}`);
          }
          const targets = ringTargets(me.worldId, base);
          if (targets.length === 0) throw new Error('no legal occupy target around base');
          bots.push({ id: i, token: login.token, worldId: me.worldId, base, targets, nextTargetIdx: 0 });
        } catch (e) {
          rampErrors.push((e as Error).message);
        }
      });
      const rampMs = Date.now() - rampStart;
      log(`[load] ramp: ${bots.length}/${BOTS} bots ready in ${rampMs}ms (${rampErrors.length} failed, ${strayJoins} landed in another world)`);
      if (rampErrors.length > 0) log(`[load] ramp failure sample: ${JSON.stringify(rampErrors.slice(0, 5))}`);
      expect(bots.length, `too few bots reached the world: ${JSON.stringify(rampErrors.slice(0, 3))}`).toBeGreaterThan(BOTS * 0.8);

      const before = await admin.metrics();

      // ── Load window ─────────────────────────────────────────────────────────────────────────────────
      const outcomes: OrderOutcome[] = [];
      const reads: Record<ReadKind, number[]> = { orders: [], map: [] };
      let readFailures = 0;
      const stormStart = Date.now();
      const running = (): boolean => Date.now() - stormStart < WINDOW_MS;

      const read = async (kind: ReadKind, bot: Bot, path: string): Promise<void> => {
        const t0 = Date.now();
        try {
          await api('GET', path, { token: bot.token });
          reads[kind].push(Date.now() - t0);
        } catch {
          readFailures++;
        }
      };

      const march = async (bot: Bot): Promise<boolean> => {
        const target = bot.targets[bot.nextTargetIdx % bot.targets.length]!;
        bot.nextTargetIdx++;
        const t0 = Date.now();
        try {
          await api('POST', '/world/march', {
            token: bot.token,
            body: {
              worldId: bot.worldId,
              fromX: bot.base.x,
              fromY: bot.base.y,
              toX: target.x,
              toY: target.y,
              kind: 'occupy',
              troops: OCCUPY_MIN_TROOPS,
            },
          });
          outcomes.push({ ms: Date.now() - t0, ok: true, reason: null });
          return true;
        } catch (e) {
          outcomes.push({ ms: Date.now() - t0, ok: false, reason: (e as Error).message });
          return false;
        }
      };

      const orderLoop = async (bot: Bot): Promise<void> => {
        if (MODEL === 'storm') {
          // Stagger starts across one interval so the fleet spreads over the window instead of arriving
          // as one thundering herd every ORDER_MS — real players are not synchronised.
          await sleep(Math.random() * ORDER_MS);
          while (running()) {
            const t0 = Date.now();
            await march(bot);
            const wait = ORDER_MS - (Date.now() - t0);
            if (wait > 0) await sleep(wait);
          }
          return;
        }
        for (;;) {
          await sleep(expGap(ORDER_MS));
          if (!running()) return;
          // The client refetches its orders when the march_update push for a dispatch lands (refreshMarches).
          if (await march(bot)) await read('orders', bot, `/world/orders?worldId=${bot.worldId}`);
        }
      };

      const mapLoop = async (bot: Bot): Promise<void> => {
        if (MAP_MS <= 0) return;
        for (;;) {
          await sleep(expGap(MAP_MS));
          if (!running()) return;
          await read('map', bot, `/world/map?worldId=${bot.worldId}&cx=${bot.base.x}&cy=${bot.base.y}&r=20`);
        }
      };

      await Promise.all(bots.flatMap((b) => [orderLoop(b), mapLoop(b)]));
      const stormMs = Date.now() - stormStart;
      const after = await admin.metrics();

      // ── Report ──────────────────────────────────────────────────────────────────────────────────────
      const byReason = new Map<string, number>();
      for (const o of outcomes) if (!o.ok) byReason.set(o.reason!, (byReason.get(o.reason!) ?? 0) + 1);
      // An exhausted troop pool is the game's economy working, not the server failing: 5000 troops buys
      // ~10 occupy orders. Counted, reported, and excluded from the success rate.
      const exhausted = [...byReason.entries()].filter(([r]) => /NO_TROOPS|Insufficient/i.test(r)).reduce((n, [, c]) => n + c, 0);
      const accepted = outcomes.filter((o) => o.ok).length;
      const judged = outcomes.length - exhausted;
      const okPct = judged > 0 ? (accepted / judged) * 100 : 0;
      const lat = outcomes.filter((o) => o.ok).map((o) => o.ms).sort((a, b) => a - b);
      const perSec = outcomes.length / (stormMs / 1000);

      const delta = (k: string): number => (after.counters?.[k] ?? 0) - (before.counters?.[k] ?? 0);
      const mongo = counterRates(before, after, stormMs, 'mongo.op');
      const mongoTotal = mongo.find(([k]) => k === 'mongo.ops')?.[1] ?? 0;
      const mongoTop = mongo.filter(([k]) => k !== 'mongo.ops').slice(0, 6);
      const pushes = counterRates(before, after, stormMs, 'push.');
      const pushTotal = pushes.find(([k]) => k === 'push.sent')?.[1] ?? 0;
      const pushTop = pushes.filter(([k]) => k !== 'push.sent').slice(0, 5);
      const sieges = labelCount(before, after, 'compute:siege:run');
      const fmt = (xs: [string, number][], cut: number): string => xs.map(([k, v]) => `${k.slice(cut)} ${v.toFixed(1)}`).join(', ');

      log(`[load] window ${stormMs}ms | orders ${outcomes.length} (${perSec.toFixed(1)}/s) | accepted ${accepted} | out-of-troops ${exhausted} | other rejects ${judged - accepted}`);
      log(`[load] POST /world/march: ${latencyLine(lat)}`);
      if (reads.orders.length > 0) log(`[load] GET /world/orders: ${latencyLine(reads.orders)}`);
      if (reads.map.length > 0) log(`[load] GET /world/map r=20: ${latencyLine(reads.map)}`);
      if (readFailures > 0) log(`[load] read failures: ${readFailures}`);
      if (byReason.size > 0) log(`[load] rejects: ${JSON.stringify(Object.fromEntries(byReason))}`);
      log(`[load] ① Mongo ${mongoTotal.toFixed(1)} ops/s (idle ${idleOps?.toFixed(1) ?? '-'}) = ${(mongoTotal / ATLAS_M0_OPS_PER_SEC).toFixed(1)}× Atlas M0's ${ATLAS_M0_OPS_PER_SEC} | ${fmt(mongoTop, 'mongo.op.'.length)}`);
      log(`[load] ② compute (${after.compute}): ${sieges} sieges | run ${labelLine(after, 'compute:siege:run')} | wait ${labelLine(after, 'compute:siege:wait')}`);
      log(`[load]    path: ${labelCount(before, after, 'compute:path:run')} jobs | run ${labelLine(after, 'compute:path:run')} | wait ${labelLine(after, 'compute:path:wait')}`);
      log(`[load]    hang-guard timeouts: siege ${delta('compute.timeout.siege')}, path ${delta('compute.timeout.path')}, warm ${delta('compute.timeout.warm')} | worker restarts ${delta('compute.workerDown')}`);
      log(`[load] ③ settlement: settled ${delta('arrivals.settled')}, deferred ${delta('arrivals.deferred')} | sched:arrivalSettle ${labelLine(after, 'sched:arrivalSettle')} | sched:arrivals ${labelLine(after, 'sched:arrivals')}`);
      log(`[load] ④ push ${pushTotal.toFixed(1)}/s | ${fmt(pushTop, 'push.'.length)} | vision:observers ${labelCount(before, after, 'vision:observers')}× ${labelLine(after, 'vision:observers')}`);
      const elu = eluBetween(before, after);
      log(`[load] main thread: utilization ${elu == null ? '-' : `${(elu * 100).toFixed(0)}%`} | loop lag max ${after.loopLagMs?.max ?? '-'}ms  p99 ${after.loopLagMs?.p99 ?? '-'}ms`);

      if (REPORT_FILE) {
        appendFileSync(REPORT_FILE, JSON.stringify({
          at: new Date().toISOString(), world: loadWorld, model: MODEL, bots: bots.length, orderMs: ORDER_MS, mapMs: MAP_MS,
          windowMs: stormMs, ordersPerSec: perSec, accepted, exhausted, rejects: judged - accepted,
          march: { p50: pct(lat, 0.5), p90: pct(lat, 0.9), p99: pct(lat, 0.99), max: lat.at(-1) ?? 0 },
          mongoOpsPerSec: mongoTotal, idleMongoOpsPerSec: idleOps, mongoTop: Object.fromEntries(mongoTop),
          compute: after.compute, sieges, pathJobs: labelCount(before, after, 'compute:path:run'),
          timeouts: { siege: delta('compute.timeout.siege'), path: delta('compute.timeout.path') }, workerRestarts: delta('compute.workerDown'), siegeRun: after.labels?.['compute:siege:run'], siegeWait: after.labels?.['compute:siege:wait'],
          settled: delta('arrivals.settled'), deferred: delta('arrivals.deferred'), arrivalSettle: after.labels?.['sched:arrivalSettle'],
          pushesPerSec: pushTotal, visionObservers: after.labels?.['vision:observers'], loopLag: after.loopLagMs, elu,
        }) + '\n');
      }

      expect(outcomes.length, 'no orders were issued at all').toBeGreaterThan(0);
      expect(okPct, `too many rejected orders: ${JSON.stringify(Object.fromEntries(byReason))}`).toBeGreaterThanOrEqual(MIN_OK_PCT);
      expect(pct(lat, 0.99)).toBeLessThan(P99_BUDGET_MS);

      // The server-side assertions — the ones a client-side latency number cannot make.
      expect(after.loopLagMs?.max ?? 0, 'worldsvc event loop stalled — pathfinding or another sync CPU burst is back on the request thread').toBeLessThan(LOOP_BUDGET_MS);
      // The arrival tick: `arrivals.batched` says whether the batching engaged at all — a tick that quietly
      // demoted every march back to the per-march path is slow in exactly the way everything else is slow.
      const arrivals = after.labels?.['sched:arrivals'];
      if (arrivals) {
        expect(
          arrivals.p50 ?? 0,
          'a typical arrival tick is no longer cheap — the per-march stepping loop is back (see ARRIVALS_P50_BUDGET_MS)',
        ).toBeLessThan(ARRIVALS_P50_BUDGET_MS);
        expect(delta('arrivals.batched'), 'no march took the batched path at all — the split rules rejected everything').toBeGreaterThan(0);
      }
    } finally {
      if (!KEEP_WORLD) await admin.closeWorld(loadWorld).catch((e: Error) => log(`[load] could not close ${loadWorld}: ${e.message}`));
    }
    /* eslint-enable no-console */
  });
});
