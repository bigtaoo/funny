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
// That is also why each run gets a FRESH device-id prefix by default. Device login is idempotent per
// deviceId, so a fixed prefix means the second run inherits the first run's spent troop pools: the very
// first execution of this test measured 200 bots, and the next one measured 200 bots answering NO_TROOPS
// in 5ms — a much prettier latency number describing nothing. Set NW_LOAD_FLEET_ID to reuse a fleet
// deliberately (e.g. to keep re-running against the same accounts); expect exhausted pools if you do.
import { describe, it, expect } from 'vitest';
import {
  proceduralTile,
  OCCUPY_MIN_TROOPS,
  SLG_MAP_W,
  SLG_MAP_H,
  runBounded,
} from '@nw/shared';

const BASE = process.env.NW_LOAD_BASE ?? 'http://localhost:8088';
const METRICS_BASE = process.env.NW_LOAD_METRICS_BASE ?? 'http://localhost:18084';
const WORLD_BASE = process.env.NW_LOAD_WORLD_BASE ?? METRICS_BASE;
const BOTS = Number(process.env.NW_LOAD_BOTS ?? 200);
const ORDER_MS = Number(process.env.NW_LOAD_ORDER_MS ?? 2500);
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

/** worldsvc's own view of itself; null when the internal port is not reachable (the run still measures client-side). */
async function serverMetrics(): Promise<Record<string, unknown> | null> {
  if (!INTERNAL_KEY) return null;
  try {
    const res = await fetch(`${METRICS_BASE}/admin/world/metrics`, { headers: { 'x-internal-key': INTERNAL_KEY } });
    const parsed = (await res.json()) as { ok: boolean; data?: Record<string, unknown> };
    return parsed.ok ? (parsed.data ?? null) : null;
  } catch {
    return null;
  }
}

describe('worldsvc SLG order throughput', () => {
  it(`digests ${BOTS} bots issuing march orders every ${ORDER_MS}ms`, async () => {
    // Fail loudly rather than "0 bots, 100% success" if the stack is not up — a load test that passes
    // against nothing is worse than one that errors.
    const season = await api<{ season: number }>('GET', '/world/active-season');
    expect(season.season, 'no active season — is the stack up and a world open?').toBeGreaterThan(0);

    // ── Ramp: device login + join the season, bounded so the ramp itself is not the bottleneck ──
    const bots: Bot[] = [];
    const rampErrors: string[] = [];
    const ids = Array.from({ length: BOTS }, (_, i) => i);
    const rampStart = Date.now();
    await runBounded(ids, LOGIN_CONC, async (i) => {
      try {
        const login = await api<{ token: string }>('POST', '/api/auth/device', {
          body: { deviceId: `loadbot-${FLEET_ID}-${i}` },
        });
        const me = await api<{ worldId?: string; mainBaseTile?: string }>('POST', '/world/season/join', {
          token: login.token,
          body: { season: season.season },
        });
        const base = me.mainBaseTile ? parseTile(me.mainBaseTile) : null;
        if (!me.worldId || !base) throw new Error('joined without a base');
        const targets = ringTargets(me.worldId, base);
        if (targets.length === 0) throw new Error('no legal occupy target around base');
        bots.push({ id: i, token: login.token, worldId: me.worldId, base, targets, nextTargetIdx: 0 });
      } catch (e) {
        rampErrors.push((e as Error).message);
      }
    });
    const rampMs = Date.now() - rampStart;
    // eslint-disable-next-line no-console
    console.log(`[load] ramp: ${bots.length}/${BOTS} bots ready in ${rampMs}ms (${rampErrors.length} failed)`);
    if (rampErrors.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[load] ramp failure sample: ${JSON.stringify(rampErrors.slice(0, 5))}`);
    }
    expect(bots.length, `too few bots reached the world: ${JSON.stringify(rampErrors.slice(0, 3))}`).toBeGreaterThan(BOTS * 0.8);

    const before = await serverMetrics();

    // ── Storm: every bot issues one order per ORDER_MS for WINDOW_MS ────────────────────────────────
    const outcomes: OrderOutcome[] = [];
    const stormStart = Date.now();
    const runBot = async (bot: Bot): Promise<void> => {
      // Stagger starts across one interval so the fleet spreads over the window instead of arriving as
      // one thundering herd every ORDER_MS — real players are not synchronised.
      await new Promise((r) => setTimeout(r, Math.random() * ORDER_MS));
      while (Date.now() - stormStart < WINDOW_MS) {
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
        } catch (e) {
          outcomes.push({ ms: Date.now() - t0, ok: false, reason: (e as Error).message });
        }
        const wait = ORDER_MS - (Date.now() - t0);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    };
    await Promise.all(bots.map(runBot));
    const stormMs = Date.now() - stormStart;

    const after = await serverMetrics();

    // ── Report ──────────────────────────────────────────────────────────────────────────────────────
    const byReason = new Map<string, number>();
    for (const o of outcomes) if (!o.ok) byReason.set(o.reason!, (byReason.get(o.reason!) ?? 0) + 1);
    // An exhausted troop pool is the game's economy working, not the server failing: 5000 troops buys
    // ~10 occupy orders. Counted, reported, and excluded from the success rate.
    const exhausted = [...byReason.entries()].filter(([r]) => /NO_TROOPS|Insufficient/i.test(r)).reduce((s, [, n]) => s + n, 0);
    const accepted = outcomes.filter((o) => o.ok).length;
    const judged = outcomes.length - exhausted;
    const okPct = judged > 0 ? (accepted / judged) * 100 : 0;
    const lat = outcomes.filter((o) => o.ok).map((o) => o.ms).sort((a, b) => a - b);
    const perSec = outcomes.length / (stormMs / 1000);

    /* eslint-disable no-console */
    console.log(`[load] window ${stormMs}ms | orders ${outcomes.length} (${perSec.toFixed(1)}/s) | accepted ${accepted} | out-of-troops ${exhausted} | other rejects ${judged - accepted}`);
    console.log(`[load] dispatch latency: p50 ${pct(lat, 0.5)}ms  p90 ${pct(lat, 0.9)}ms  p99 ${pct(lat, 0.99)}ms  max ${lat.at(-1) ?? 0}ms`);
    if (byReason.size > 0) console.log(`[load] rejects: ${JSON.stringify(Object.fromEntries(byReason))}`);
    if (after) console.log(`[load] worldsvc after: ${JSON.stringify(after)}`);
    else console.log(`[load] worldsvc metrics unreachable at ${METRICS_BASE} — is 18084 published? (client-side numbers above are still valid)`);
    void before;
    /* eslint-enable no-console */

    expect(outcomes.length, 'no orders were issued at all').toBeGreaterThan(0);
    expect(okPct, `too many rejected orders: ${JSON.stringify(Object.fromEntries(byReason))}`).toBeGreaterThanOrEqual(MIN_OK_PCT);
    expect(pct(lat, 0.99)).toBeLessThan(P99_BUDGET_MS);

    // The server-side assertion — the one a client-side latency number cannot make. Skipped rather than
    // faked when the internal port is not reachable.
    if (after) {
      const loop = (after.loopLagMs ?? {}) as { max?: number };
      expect(loop.max ?? 0, 'worldsvc event loop stalled — pathfinding or another sync CPU burst is back on the request thread').toBeLessThan(LOOP_BUDGET_MS);

      // The arrival tick: the bottleneck this run surfaced in the first place. `arrivals.batched` /
      // `arrivals.serial` say whether the batching engaged at all — a tick that quietly demoted every march
      // back to the per-march path is slow in exactly the way everything else here is slow, so the split has
      // to be read as a number rather than inferred from the timing.
      const labels = (after.labels ?? {}) as Record<string, { p50?: number; p90?: number; max?: number }>;
      const arrivals = labels['sched:arrivals'];
      const counters = (after.counters ?? {}) as Record<string, number>;
      /* eslint-disable-next-line no-console */
      console.log(`[load] sched:arrivals p50 ${arrivals?.p50 ?? '-'}ms  p90 ${arrivals?.p90 ?? '-'}ms  max ${arrivals?.max ?? '-'}ms`);
      /* eslint-disable-next-line no-console */
      console.log(`[load] arrivals split: batched ${counters['arrivals.batched'] ?? 0} | serial ${counters['arrivals.serial'] ?? 0} (arriving ${counters['arrivals.arriving'] ?? 0}, blocked ${counters['arrivals.blocked'] ?? 0}, legacy ${counters['arrivals.legacy'] ?? 0})`);
      if (arrivals) {
        expect(
          arrivals.p50 ?? 0,
          'a typical arrival tick is no longer cheap — the per-march stepping loop is back (see ARRIVALS_P50_BUDGET_MS)',
        ).toBeLessThan(ARRIVALS_P50_BUDGET_MS);
        expect(counters['arrivals.batched'] ?? 0, 'no march took the batched path at all — the split rules rejected everything').toBeGreaterThan(0);
      }
    }
  });
});
