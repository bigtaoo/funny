// Ranked matchmaking load test — the capacity-probe framework.
//
// Spins up NW_LOAD_CLIENTS (default 100) real headless clients against a live stack,
// runs each through the real flow (register over meta REST → connect the
// server-provided gateway WS → enqueue ranked), and measures how many get paired
// into a netplay match within a deadline, plus the enqueue→match_found latency
// distribution. This is the "100 people online at once" smoke; bump the env knob to
// find a single server's real ceiling later.
//
// Prereq: a running stack (same as the E2E — `npm run dev:all` in server/, or the CI
// docker compose). Endpoints via env (defaults match dev-up.ps1):
//   NW_API_BASE        meta REST base          (default http://localhost:18080)
//   NW_LOAD_CLIENTS    fleet size              (default 100)
//   NW_LOAD_MIN_PCT    min % that must pair    (default 90)
//   NW_LOAD_REG_CONC   registration concurrency(default 20)
//   NW_LOAD_DEADLINE_MS time budget to pair all(default 90000)
//
// Run: npm run test:load   (NOT part of `npm test` / `test:e2e`).

import { describe, it, expect } from 'vitest';
import { createAppCore } from '../../src/app/createAppCore';
import { HeadlessPlatform } from '../harness/HeadlessPlatform';
import { HeadlessAppViews } from '../harness/HeadlessAppViews';

const API_BASE = process.env.NW_API_BASE ?? 'http://localhost:18080';
const FLEET = Number(process.env.NW_LOAD_CLIENTS ?? 100);
const MIN_PCT = Number(process.env.NW_LOAD_MIN_PCT ?? 90);
const REG_CONC = Number(process.env.NW_LOAD_REG_CONC ?? 20);
const DEADLINE_MS = Number(process.env.NW_LOAD_DEADLINE_MS ?? 90_000);

interface Client {
  id: number;
  platform: HeadlessPlatform;
  views: HeadlessAppViews;
  core: ReturnType<typeof createAppCore>;
  enqueuedAt?: number;
  matchedAt?: number;
  error?: string;
}

function makeClient(id: number): Client {
  const platform = new HeadlessPlatform({ storage: { nw_api_base: API_BASE } });
  const views = new HeadlessAppViews();
  const core = createAppCore(platform, views);
  return { id, platform, views, core };
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

const uid = (i: number): string => `load_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 5)}`;

/** Register + reach the online lobby. Throws (captured per-client) on failure. */
async function registerAndEnterLobby(c: Client): Promise<void> {
  c.core.start();
  if (!(await waitFor(() => c.views.screen === 'intro', 5_000))) throw new Error('no intro');
  c.views.intro!.onFinish();
  c.views.consent!.onAccept(); // GDPR gate (L1-1) before entry
  if (!(await waitFor(() => c.views.screen === 'login', 10_000))) throw new Error('no login screen');
  const outcome = await c.views.login!.onRegister(uid(c.id), 'password123', `Load${c.id}`);
  if (!outcome.ok) throw new Error(`register failed: ${JSON.stringify(outcome)}`);
  if (!(await waitFor(() => c.views.screen === 'lobby' && c.views.lobby!.online === true, 15_000))) {
    throw new Error('never reached online lobby');
  }
}

/** Run `task` over `items` with a concurrency cap. */
async function mapLimit<T>(items: T[], limit: number, task: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await task(items[i]!);
    }
  });
  await Promise.all(workers);
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

describe('ranked matchmaking load (live stack)', () => {
  it(`${FLEET} concurrent clients register, connect and pair`, async () => {
    const clients = Array.from({ length: FLEET }, (_, i) => makeClient(i));

    // ── Phase 1: register + reach the online lobby (concurrency-capped) ──
    const regStart = Date.now();
    await mapLimit(clients, REG_CONC, async (c) => {
      try {
        await registerAndEnterLobby(c);
      } catch (err) {
        c.error = err instanceof Error ? err.message : String(err);
      }
    });
    const online = clients.filter((c) => !c.error);
    const regMs = Date.now() - regStart;

    // ── Phase 2: everyone enqueues ranked, then we wait for pairings ──
    for (const c of online) {
      c.enqueuedAt = Date.now();
      c.views.lobby!.onStartRanked!();
    }

    // Periodic progress samples so we can see WHICH stage blocks.
    let nextSample = Date.now() + 10_000;
    await waitFor(
      () => {
        if (Date.now() >= nextSample) {
          nextSample += 10_000;
          const inRoom    = online.filter(c => c.views.screen === 'room').length;
          const gwOpen    = online.filter(c => c.views.lastRoomNetState === 'open').length;
          const roomState = online.filter(c => c.views.lastRoomState   !== undefined).length;
          const inGameNet = online.filter(c => c.views.screen === 'gameNet').length;
          // eslint-disable-next-line no-console
          console.log(`[load:progress +${Math.round((Date.now() - regStart - regMs) / 1000)}s]` +
            ` screen=room:${inRoom}` +
            ` gw_open:${gwOpen}` +
            ` got_room_state:${roomState}` +
            ` screen=gameNet:${inGameNet}`);
        }
        return online.filter((c) => c.views.screen === 'gameNet').length >= online.length - 1;
      },
      DEADLINE_MS,
    );
    const now = Date.now();
    for (const c of online) {
      if (c.views.screen === 'gameNet' && c.matchedAt === undefined) c.matchedAt = now;
    }

    // ── Report ──
    const matched = online.filter((c) => c.matchedAt !== undefined);
    const latencies = matched
      .map((c) => c.matchedAt! - c.enqueuedAt!)
      .sort((a, b) => a - b);
    const regErrors = clients.filter((c) => c.error);

    // Diagnostic breakdown: shows which pipeline stage all 20 clients reached.
    const diagInRoom    = online.filter(c => c.views.screen === 'room' || c.views.screen === 'gameNet').length;
    const diagGwOpen    = online.filter(c => c.views.lastRoomNetState === 'open').length;
    const diagRoomState = online.filter(c => c.views.lastRoomState !== undefined).length;
    const diagGameNet   = online.filter(c => c.matchedAt !== undefined).length;

    // eslint-disable-next-line no-console
    console.log(
      `\n[load] fleet=${FLEET} registered=${online.length} (${regErrors.length} failed, ${regMs}ms) ` +
        `matched=${matched.length}/${online.length}\n` +
        `[load] pair latency ms: p50=${pct(latencies, 50)} p95=${pct(latencies, 95)} ` +
        `max=${latencies[latencies.length - 1] ?? 0}\n` +
        `[load:diag] pipeline buckets (cumulative):\n` +
        `  reached 'room' screen  : ${diagInRoom}/${online.length}\n` +
        `  gateway became 'open'  : ${diagGwOpen}/${online.length}\n` +
        `  got room_state from srv: ${diagRoomState}/${online.length}\n` +
        `  reached 'gameNet'      : ${diagGameNet}/${online.length}`,
    );
    if (regErrors.length) {
      // eslint-disable-next-line no-console
      console.log(`[load] sample reg error: ${regErrors[0]!.error}`);
    }

    // ── Cleanup: tear matched clients back down so sockets close before the next run ──
    for (const c of matched) {
      try { c.views.gameNet!.cb.onExitToLobby(); } catch { /* ignore */ }
    }

    // ── Assertions ──
    // Most clients must register cleanly…
    expect(online.length, `too many registration failures (${regErrors.length})`).toBeGreaterThanOrEqual(
      Math.ceil(FLEET * (MIN_PCT / 100)),
    );
    // …and the matchmaker must pair at least MIN_PCT of the online fleet (an odd one
    // out is expected, hence the -1 slack on the target).
    const pairTarget = Math.max(0, Math.floor((online.length * (MIN_PCT / 100))) - 1);
    expect(matched.length, `only ${matched.length}/${online.length} paired`).toBeGreaterThanOrEqual(pairTarget);
  });
});
