// Regression guard for the 2026-09-26 "the fifth team leaves seconds late" report
// (design/game/WORLDSVC_CONCURRENCY_AUDIT_2026-09-05.md §12).
//
// worldsvc answered in ~35ms throughout that report; the delay was entirely client-side: every
// dispatch fanned out into 10-15 requests (picker lists, the order, a refresh fired by the order's
// own push echo, arrival refreshes), all queued FIFO behind the client's 5 req/s `globalRequestGate`,
// so by the fifth team the order itself sat seconds behind refreshes for the first four.
//
// The unit tests beside each fix (rate-gate, world-api-rate-lane, worldMapLoaders, worldMapPush) pin
// each piece on its own. This file pins the outcome the player feels, end to end, with the REAL
// pieces wired together — `WorldApiClient` → `WorldApiCore.req` → the real `globalRequestGate` →
// a fake transport with a fixed round trip — driven by the real `showTeamPicker` / `doMarchTeam` /
// `applyMarchUpdate` / `applyTileUpdate`. Only the server and the scene's drawing are faked.
//
// What goes red here and nowhere else: a new request added anywhere in the dispatch flow (the
// request tally below is exact on purpose — changing it should be a decision, not a side effect),
// and a player's order losing its place ahead of queued background reads.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { WorldApiClient } from '../src/net/WorldApiClient';
import { setNetTransport, fetchTransport, type NetRequest, type NetResponse } from '../src/net/transport';
import { showTeamPicker } from '../src/scenes/worldmap/net/march';
import { applyMarchUpdate, applyTileUpdate } from '../src/scenes/worldmap/net/push';
import type { WorldMapContext } from '../src/scenes/worldmap/WorldMapContext';
import type { IStorage } from '../src/platform/IPlatform';
import { t } from '../src/i18n';

const WORLD = 'w1';
/** Round trip of every request. The report's server time was ~35ms; 80ms leaves room for a phone network. */
const RTT = 80;
/** The gate's refill interval (rateGate.ts REFILL_MS) — the most a queued order may wait for a token. */
const REFILL_MS = 200;
/** The player's pause between reading the picker and tapping a team, and between two dispatches. */
const THINK_MS = 500;
/** Adjacent tile: the march lands a few seconds after it leaves. */
const MARCH_MS = 6000;
const BASE: [number, number] = [50, 50];

interface Sent { method: string; route: string; at: number }

interface ModalButtonLike { label: string; action: () => void }

/** A worldsvc stand-in that answers after RTT and pushes the way the gateway does. */
function world(teamCount: number) {
  const sent: Sent[] = [];
  const marches: Array<Record<string, unknown>> = [];
  const occupations: Array<Record<string, unknown>> = [];
  const teams = Array.from({ length: teamCount }, (_, i) => ({
    id: `t${i + 1}`,
    army: [{ cardInstanceId: `card${i + 1}`, x: 0, y: 0 }],
  }));
  const me = {
    joined: true,
    mainBaseTile: `${WORLD}:${BASE[0]}:${BASE[1]}`,
    cardState: Object.fromEntries(teams.map((tm, i) => [`card${i + 1}`, { currentTroops: 1000 }])) as Record<string, unknown>,
  };
  let marchSeq = 0;
  /** Set once the scene exists: pushes are delivered straight into its handlers. */
  let ctx: WorldMapContext | null = null;

  const answer = (data: unknown): NetResponse => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data }),
    text: async () => JSON.stringify({ ok: true, data }),
  });

  const handle = (req: NetRequest): unknown => {
    const route = new URL(req.url, 'http://w').pathname;
    if (req.method === 'GET' && route === '/world/teams') return teams;
    if (req.method === 'GET' && route === '/world/orders') {
      return { marches: [...marches], occupations: [...occupations], stationed: [], siegeHolds: [] };
    }
    if (req.method === 'GET' && route === '/world/map') return { tiles: [] };
    if (req.method === 'POST' && route === '/world/march') {
      const body = JSON.parse(req.body ?? '{}') as { toX: number; toY: number; kind: string; teamId: string };
      const march = {
        marchId: `m${++marchSeq}`,
        kind: body.kind,
        teamId: body.teamId,
        fromTile: me.mainBaseTile,
        toTile: `${WORLD}:${body.toX}:${body.toY}`,
        arriveAt: Date.now() + MARCH_MS,
        status: 'marching',
        mine: true,
      };
      marches.push(march);
      // worldsvc pushes march_update to the dispatcher before answering; it lands around the response.
      const push = { marchId: march.marchId, kind: march.kind, fromTile: march.fromTile, toTile: march.toTile, arriveAt: march.arriveAt, status: 'marching' };
      setTimeout(() => { if (ctx) applyMarchUpdate(ctx, push); }, RTT / 2);
      // Arrival: the march becomes an occupation hold; the gateway pushes the march and the tile.
      setTimeout(() => {
        marches.splice(marches.indexOf(march), 1);
        occupations.push({ tileId: march.toTile, teamId: march.teamId });
        if (ctx) {
          applyMarchUpdate(ctx, { ...push, status: 'arrived' });
          applyTileUpdate(ctx, { tileId: march.toTile, type: 'plain', level: 1 } as never);
        }
      }, MARCH_MS);
      return { ...march, me };
    }
    throw new Error(`fake worldsvc: no route for ${req.method} ${route}`);
  };

  setNetTransport({
    request: (req) => {
      sent.push({ method: req.method, route: new URL(req.url, 'http://w').pathname, at: Date.now() });
      const data = handle(req);
      return new Promise((resolve) => { setTimeout(() => resolve(answer(data)), RTT); });
    },
  });

  return {
    sent, teams, me,
    attach(c: WorldMapContext) { ctx = c; },
  };
}

/** The slice of WorldMapContext the picker, the dispatch and the push handlers touch. */
function scene(w: ReturnType<typeof world>) {
  const storage: IStorage = { getItem: () => 'token', setItem: () => {}, removeItem: () => {} } as unknown as IStorage;
  const modals: ModalButtonLike[][] = [];
  const toasts: string[] = [];
  const ctx = {
    destroyed: false,
    zoom: 1,
    me: w.me,
    marches: [] as unknown[],
    occupations: [] as unknown[],
    stationed: [] as unknown[],
    siegeHolds: [] as unknown[],
    tileCache: new Map<string, unknown>(),
    parseTileId: (id: string) => {
      const [, x, y] = id.split(':');
      return [Number(x), Number(y)] as [number, number];
    },
    cb: { worldId: WORLD, worldApi: new WorldApiClient(storage) },
    view: {
      viewportCenter: () => ({ cx: BASE[0], cy: BASE[1], r: 7 }),
      renderMap: () => {},
      flashDamageVignette: () => {},
    },
    panels: {
      renderHud: () => {},
      showToast: (msg: string) => { toasts.push(msg); },
      showModal: (_lines: unknown, buttons: ModalButtonLike[]) => { modals.push(buttons); },
      closeModal: () => {},
    },
  } as unknown as WorldMapContext;
  w.attach(ctx);
  return { ctx, modals, toasts };
}

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

/** Tally of requests by "METHOD route", for an exact budget assertion. */
function tally(sent: Sent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sent) out[`${s.method} ${s.route}`] = (out[`${s.method} ${s.route}`] ?? 0) + 1;
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(async () => {
  // Drain the shared gate's refill timer and any leftover pushes before the next case.
  await vi.advanceTimersByTimeAsync(60_000);
  vi.useRealTimers();
  setNetTransport(fetchTransport);
});

describe('five-team SLG dispatch burst (end to end through the real rate gate)', () => {
  it('every team leaves one round trip after the tap — the fifth exactly as fast as the first', async () => {
    const w = world(5);
    const { ctx, modals, toasts } = scene(w);
    const pending = new Set<string>();
    const steps: Array<{ pickerMs: number; orderWaitMs: number }> = [];

    const player = (async () => {
      for (let i = 0; i < 5; i++) {
        // Occupy the next tile over, as in the report.
        const opened = Date.now();
        await showTeamPicker(ctx, pending, BASE[0] + 1 + i, BASE[1], 'occupy');
        const pickerMs = Date.now() - opened;
        await sleep(THINK_MS);
        const tapped = Date.now();
        const sentBefore = w.sent.length;
        modals[modals.length - 1]![0]!.action(); // first row = nearest free team
        await sleep(RTT + 1);
        const order = w.sent.slice(sentBefore).find((s) => s.method === 'POST');
        expect(order, `team ${i + 1}: no order went out`).toBeDefined();
        steps.push({ pickerMs, orderWaitMs: order!.at - tapped });
        await sleep(THINK_MS);
      }
    })();
    await vi.advanceTimersByTimeAsync(5 * (2 * THINK_MS + 2 * RTT) + MARCH_MS + 2000);
    await player;

    expect(toasts).toEqual(Array(5).fill(t('world.dispatched'))); // no error toast among them
    for (const [i, s] of steps.entries()) {
      // The picker's two reads go out together: one round trip, no gate wait.
      expect(s.pickerMs, `team ${i + 1} picker`).toBe(RTT);
      // The order goes out on the tap itself.
      expect(s.orderWaitMs, `team ${i + 1} order`).toBe(0);
    }
    // Each march went out with a different team, all five now holding their tiles.
    expect(new Set(ctx.occupations.map((o) => (o as { teamId: string }).teamId)).size).toBe(5);

    // The whole burst's request budget. Before the fix this was ~65 requests: the picker read four
    // order slices, every dispatch's own push echo re-read them again, and so did every arrival.
    // Per team now: picker (teams + orders) + the order + arrival (orders + the tile's viewport).
    // The echo of the player's own order costs nothing.
    expect(tally(w.sent)).toEqual({
      'GET /world/teams': 5,
      'GET /world/orders': 10,
      'POST /world/march': 5,
      'GET /world/map': 5,
    });
  });

  it("the player's order is not queued behind a backlog of background reads", async () => {
    // A busy map: other players' fights nearby push a tile_update each, and each one re-reads the
    // viewport. Those reads drain the bucket and queue; the order the player taps meanwhile must go
    // out on the next refill tick, ahead of them — not after the whole backlog.
    const w = world(1);
    const { ctx, modals } = scene(w);
    const pending = new Set<string>();

    const opened = showTeamPicker(ctx, pending, BASE[0] + 1, BASE[1], 'occupy');
    await vi.advanceTimersByTimeAsync(RTT);
    await opened;
    await vi.advanceTimersByTimeAsync(2000); // bucket back to full

    for (let i = 0; i < 12; i++) applyTileUpdate(ctx, { tileId: `${WORLD}:${60 + i}:60`, type: 'plain', level: 1 } as never);
    const tapped = Date.now();
    modals[0]![0]!.action();
    await vi.advanceTimersByTimeAsync(5000);

    const order = w.sent.find((s) => s.method === 'POST')!;
    expect(order.at - tapped).toBeLessThanOrEqual(REFILL_MS);
    // It really did jump the queue: most of the backlog went out after it.
    const readsAfter = w.sent.filter((s) => s.route === '/world/map' && s.at > order.at).length;
    expect(readsAfter).toBe(12 - 5);
  });
});
