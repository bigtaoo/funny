// Regression coverage for the 2026-07-28+1 "roster loses SLG team/troop data" fix (see
// design/game/CHARACTER_CARDS_DESIGN.md §10.1 + roster-hero-card-fixes memory).
//
// Root cause: goCardRoster's give-up timeout used to be a flat 1.5s — tighter than
// resolveWorldShard's own 3s worldsvc-unreachable fallback — so a merely-slow (not down) worldsvc
// reliably lost the whole cardState/teams fetch: the give-up fired before shard resolution even
// finished, and there was no way to push a later-arriving fetch into the already-open roster
// (CardScene had no apply* hook). Every card looked never-deployed even though the fetch would have
// succeeded a moment later.
//
// This pins three things about goCardRoster (client/src/app/nav/game.ts):
//  1. Fast path — the SLG fetch resolves before the give-up budget: the roster opens exactly once,
//     already carrying cardState/teamNames.
//  2. Slow path — the give-up fires first (roster opens with no SLG data), and the fetch resolving
//     afterward patches cb.getCardState()/getTeamName() AND calls the returned CardRosterView's
//     applyCardState() exactly once, instead of the data being silently dropped.
//  3. Slow path + eventual failure — give-up already opened the roster; the failure is a no-op (no
//     crash, no second open, no patch call).
//
// Uses a stubbed global fetch (same technique as social-world-status-parallel-fetch.test.ts /
// world-api-health.test.ts) since WorldApiClient.getMe/getTeams go through the real fetch API, plus
// vitest fake timers to control the give-up race precisely.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createGameNav } from '../src/app/nav/game';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { AppViews } from '../src/app/AppViews';
import type { ApiClient } from '../src/net/ApiClient';
import type { CardCallbacks, CardRosterView } from '../src/scenes/CardScene';
import type { WorldApiClient } from '../src/net/WorldApiClient';

const GIVE_UP_MS = 2500; // must match CARD_ROSTER_SLG_BUDGET_MS in game.ts

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function buildCtx(): {
  ctx: AppCtx;
  getCardRoster: () => CardCallbacks | null;
  showCardRosterCallCount: () => number;
  applyCardStateCallCount: () => number;
} {
  let lastCardRoster: CardCallbacks | null = null;
  let showCardRosterCalls = 0;
  let applyCardStateCalls = 0;

  const views = {
    showCardRoster: (cb: CardCallbacks): CardRosterView => {
      showCardRosterCalls++;
      lastCardRoster = cb;
      return { applyCardState: () => { applyCardStateCalls++; } };
    },
  } as unknown as AppViews;

  const ctx: AppCtx = {
    platform: {
      storage: {
        getItem: (): string | null => 'FAKE_TOKEN', // any truthy token — the online+logged-in branch
        setItem: (): void => {},
        removeItem: (): void => {},
      },
    } as unknown as AppCtx['platform'],
    views,
    api: {} as unknown as ApiClient,
    baseUrl: null,
    saveManager: {
      get: () => ({ cardInv: {}, equipmentInv: {}, inventory: { skins: [] }, equipped: {} }),
      update: () => {},
    } as unknown as AppCtx['saveManager'],
    replayStore: {} as unknown as AppCtx['replayStore'],
    featureFlags: null,
    state: { inLobby: true } as unknown as AppState,
    nav: { goLobby: () => {} } as unknown as Nav,
    getNetSession: () => null,
    applyGatewayUrl: () => {},
    playerName: () => 'tester',
    avatarId: () => undefined,
    gateConsent: (next) => next(),
    resolvePvpDeck: () => [],
    keepReplay: (r) => r,
    // Resolves the shard synchronously — this suite is only about the getMe/getTeams timing race
    // against the give-up, not resolveWorldShard's own shard-selection logic (covered elsewhere).
    resolveWorldShard: (_worldApi: WorldApiClient, then: (worldId: string) => void) => then('s1-0'),
  };

  return {
    ctx,
    getCardRoster: () => lastCardRoster,
    showCardRosterCallCount: () => showCardRosterCalls,
    applyCardStateCallCount: () => applyCardStateCalls,
  };
}

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).fetch;
});

describe('goCardRoster — SLG cardState/teams fetch vs. give-up timing', () => {
  it('fast path: fetch resolves before the give-up budget — roster opens once, already carrying the data', async () => {
    (globalThis as Record<string, unknown>).fetch = async (url: string) => {
      if (url.includes('/world/me')) return jsonResponse({ ok: true, data: { cardState: { c1: { currentTroops: 5, teamId: 't1' } } } });
      if (url.includes('/world/teams')) return jsonResponse({ ok: true, data: [{ id: 't1', name: 'Team 1', army: [] }] });
      throw new Error(`unexpected fetch in test: ${url}`);
    };

    vi.useFakeTimers();
    const { ctx, getCardRoster, showCardRosterCallCount, applyCardStateCallCount } = buildCtx();
    const { goCardRoster } = createGameNav(ctx);
    goCardRoster();

    // Flush the (synchronous shard resolve + already-resolved fetch) promise chain, well short of
    // the give-up budget — proves the fetch path opened it, not a timeout.
    await vi.advanceTimersByTimeAsync(100);

    expect(showCardRosterCallCount()).toBe(1);
    const cb = getCardRoster()!;
    expect(cb.getCardState?.()).toEqual({ c1: { currentTroops: 5, teamId: 't1' } });
    expect(cb.getTeamName?.('t1')).toBe('Team 1');
    // Nothing to patch — the roster hadn't given up yet, so applyCardState() must not fire.
    expect(applyCardStateCallCount()).toBe(0);
  });

  it('slow path: give-up opens the roster without SLG data, and the fetch resolving afterward patches it via applyCardState() instead of being dropped', async () => {
    let resolveMe!: (v: Response) => void;
    let resolveTeams!: (v: Response) => void;
    (globalThis as Record<string, unknown>).fetch = (url: string): Promise<Response> => {
      if (url.includes('/world/me')) return new Promise<Response>((res) => { resolveMe = res; });
      if (url.includes('/world/teams')) return new Promise<Response>((res) => { resolveTeams = res; });
      throw new Error(`unexpected fetch in test: ${url}`);
    };

    vi.useFakeTimers();
    const { ctx, getCardRoster, showCardRosterCallCount, applyCardStateCallCount } = buildCtx();
    const { goCardRoster } = createGameNav(ctx);
    goCardRoster();

    // Nothing has resolved yet — must not open before the give-up fires.
    expect(showCardRosterCallCount()).toBe(0);

    // Advance past the give-up budget: roster opens with no SLG data.
    await vi.advanceTimersByTimeAsync(GIVE_UP_MS);
    expect(showCardRosterCallCount()).toBe(1);
    const cb = getCardRoster()!;
    expect(cb.getCardState?.()).toBeUndefined();
    expect(applyCardStateCallCount()).toBe(0);

    // The fetch finally resolves, after the roster already gave up and opened.
    resolveMe(jsonResponse({ ok: true, data: { cardState: { c1: { currentTroops: 9, teamId: 't2' } } } }));
    resolveTeams(jsonResponse({ ok: true, data: [{ id: 't2', name: 'Team 2', army: [] }] }));
    await vi.advanceTimersByTimeAsync(0);

    // Patched in place — NOT a second roster instance.
    expect(showCardRosterCallCount()).toBe(1);
    expect(applyCardStateCallCount()).toBe(1);
    expect(cb.getCardState?.()).toEqual({ c1: { currentTroops: 9, teamId: 't2' } });
    expect(cb.getTeamName?.('t2')).toBe('Team 2');
  });

  it('slow path, fetch eventually fails: give-up already opened the roster; the failure is a no-op (no crash, no second open, no patch)', async () => {
    let rejectMe!: (e: unknown) => void;
    (globalThis as Record<string, unknown>).fetch = (url: string): Promise<Response> => {
      if (url.includes('/world/me')) return new Promise<Response>((_res, rej) => { rejectMe = rej; });
      if (url.includes('/world/teams')) return new Promise<Response>(() => {}); // never settles
      throw new Error(`unexpected fetch in test: ${url}`);
    };

    vi.useFakeTimers();
    const { ctx, getCardRoster, showCardRosterCallCount, applyCardStateCallCount } = buildCtx();
    const { goCardRoster } = createGameNav(ctx);
    goCardRoster();

    await vi.advanceTimersByTimeAsync(GIVE_UP_MS);
    expect(showCardRosterCallCount()).toBe(1);

    rejectMe(new Error('network error'));
    await vi.advanceTimersByTimeAsync(0);

    expect(showCardRosterCallCount()).toBe(1);
    expect(applyCardStateCallCount()).toBe(0);
    expect(getCardRoster()!.getCardState?.()).toBeUndefined();
  });
});
