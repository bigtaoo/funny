// Load-test harness helpers: a dedicated world per run, a quiet server before the storm, and the
// server-side counter deltas the 3000-player probe reports (ADR-092 / audit §12.7 phase 0).
//
// ── Why a dedicated SEASON, not just a fresh shard ────────────────────────────────────────────────────
// §6.6b: three back-to-back runs against the same season world drifted `POST /world/march` p50 from 7.5ms
// to 122.8ms — the test was measuring a world the previous runs had filled, not the fleet size. A fresh
// shard in the CURRENT season does not fix that: join routing (`resolveShardForJoin`) sends each new
// player to the least-populated open shard, so the moment the fresh shard outgrows an older one the
// fleet starts splitting across both. A season number nothing else uses has exactly one open world, so
// every bot lands in it and fleet size is the only variable.
//
// Side effect, bounded on purpose: `GET /world/active-season` returns the highest OPEN season, so while
// the run's world is open the local stack's active season is the load season. The run closes its world
// when it ends (`status: closed` — a flag, nothing is deleted), and closes any load world a crashed
// earlier run left open before it starts.
import { expect } from 'vitest';

/** Load-test seasons start here, far above any real season, so they can be recognised and closed. */
export const LOAD_SEASON_BASE = 900;

export interface WorldSummary {
  worldId: string;
  season: number;
  shard: number;
  status: string;
  population: number;
  capacity: number;
}

export interface MetricsSnapshot {
  loopLagMs?: { p50?: number; p90?: number; p99?: number; max?: number };
  labels?: Record<string, { count?: number; p50?: number; p90?: number; p99?: number; max?: number }>;
  counters?: Record<string, number>;
  compute?: string;
  elu?: { activeMs: number; idleMs: number };
}

/** Main-thread event-loop utilization between two snapshots (0..1), or null on a server without `elu`. */
export function eluBetween(before: MetricsSnapshot, after: MetricsSnapshot): number | null {
  if (!before.elu || !after.elu) return null;
  const active = after.elu.activeMs - before.elu.activeMs;
  const idle = after.elu.idleMs - before.elu.idleMs;
  return active + idle > 0 ? active / (active + idle) : null;
}

export class AdminClient {
  constructor(private readonly base: string, private readonly key: string) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-internal-key': this.key },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = (await res.json()) as { ok: boolean; data?: T; error?: unknown };
    if (!parsed.ok) throw new Error(`${method} ${path}: ${JSON.stringify(parsed.error)}`);
    return parsed.data as T;
  }

  listWorlds(): Promise<WorldSummary[]> {
    return this.call('GET', '/admin/world/list');
  }

  metrics(): Promise<MetricsSnapshot> {
    return this.call('GET', '/admin/world/metrics');
  }

  async openWorld(worldId: string, season: number, shard: number, capacity: number): Promise<void> {
    await this.call('POST', '/admin/world/open', { worldId, season, shard, capacity });
  }

  async closeWorld(worldId: string): Promise<void> {
    await this.call('POST', '/admin/world/close', { worldId });
  }
}

/**
 * Open a world in a season no real world uses. Closes any load world still open from a crashed run
 * first, so at most one load season is ever open.
 */
export async function provisionLoadWorld(admin: AdminClient, capacity: number): Promise<{ worldId: string; season: number }> {
  const worlds = await admin.listWorlds();
  for (const w of worlds) {
    if (w.season >= LOAD_SEASON_BASE && w.status !== 'closed') await admin.closeWorld(w.worldId);
  }
  const season = Math.max(LOAD_SEASON_BASE - 1, ...worlds.map((w) => w.season)) + 1;
  const worldId = `s${season}-0`;
  // Opening a world warms its path index on every compute worker (WorldServiceDeps.onWorldOpened), ~3s
  // each. Wait for it: otherwise the window's first marches measure the warm-up, not the fleet — the
  // first 50-bot run on a fresh world reported path wait p99 2.7s for exactly this reason.
  const warmed = async (): Promise<number> => (await admin.metrics()).counters?.['compute:warm:run.n'] ?? 0;
  const warmedBefore = await warmed();
  await admin.openWorld(worldId, season, 0, capacity);
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 500))) {
    if ((await warmed()) > warmedBefore) break;
  }
  const opened = (await admin.listWorlds()).find((w) => w.worldId === worldId);
  expect(opened?.status, `load world ${worldId} did not open`).toBe('open');
  return { worldId, season };
}

/** Mongo ops per second over `ms`, from the cumulative `mongo.ops` counter. */
async function mongoRate(admin: AdminClient, ms: number): Promise<number> {
  const a = (await admin.metrics()).counters?.['mongo.ops'] ?? 0;
  await new Promise((r) => setTimeout(r, ms));
  const b = (await admin.metrics()).counters?.['mongo.ops'] ?? 0;
  return ((b - a) * 1000) / ms;
}

/**
 * Wait until the previous run's leftovers stop generating work. The scheduler has no worldId filter, so a
 * closed world's in-flight marches and 5-minute occupations still settle on the same thread as this run's.
 *
 * "Quiet" = Mongo ops/s at or under `quietOpsPerSec` over a 10s sample. Returns the last sampled rate,
 * which doubles as the IDLE baseline: what the scheduler alone costs against Atlas's 100 ops/s with no
 * player doing anything. Returns null when the server never exposed `mongo.ops` (older build).
 */
export async function waitForQuiet(
  admin: AdminClient,
  quietOpsPerSec: number,
  maxWaitMs: number,
  log: (s: string) => void,
): Promise<number | null> {
  if ((await admin.metrics()).counters?.['mongo.ops'] == null) {
    log('[load] worldsvc has no mongo.ops counter — rebuild the image; skipping the quiesce wait');
    return null;
  }
  const deadline = Date.now() + maxWaitMs;
  let rate = await mongoRate(admin, 10_000);
  while (rate > quietOpsPerSec && Date.now() < deadline) {
    log(`[load] waiting for leftovers to settle: ${rate.toFixed(1)} Mongo ops/s (quiet at <= ${quietOpsPerSec})`);
    rate = await mongoRate(admin, 10_000);
  }
  if (rate > quietOpsPerSec) log(`[load] still ${rate.toFixed(1)} ops/s after ${maxWaitMs}ms — measuring anyway; the idle baseline below includes leftovers`);
  return rate;
}

/** Counter deltas between two snapshots, as per-second rates, largest first; zero-delta counters omitted. */
export function counterRates(before: MetricsSnapshot, after: MetricsSnapshot, windowMs: number, prefix: string): [string, number][] {
  const a = before.counters ?? {};
  const b = after.counters ?? {};
  const out: [string, number][] = [];
  for (const [k, v] of Object.entries(b)) {
    if (!k.startsWith(prefix)) continue;
    const d = v - (a[k] ?? 0);
    if (d > 0) out.push([k, (d * 1000) / windowMs]);
  }
  return out.sort((x, y) => y[1] - x[1]);
}

/**
 * Events recorded under a latency label between two snapshots, from the label's `.n` counter. Not from the
 * reservoir's `count`: the heartbeat drain makes an idle label vanish from the snapshot, which read as a
 * negative delta ("-398 sieges") in the first ladder run.
 */
export function labelCount(before: MetricsSnapshot, after: MetricsSnapshot, label: string): number {
  return (after.counters?.[`${label}.n`] ?? 0) - (before.counters?.[`${label}.n`] ?? 0);
}
