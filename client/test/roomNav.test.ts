/**
 * roomNav.test.ts — direct coverage of `app/nav/room.ts`'s `goRoom`/`goDeckBuilder`, which the
 * 2026-08-05 client-test-audit flagged as having ZERO unit tests at all (unlike `nav/lobby.ts`,
 * which at least had one file covering a corner of it).
 *
 * Drives the real `createRoomNav()`/`goRoom()` against a hand-rolled fake `NetSession` (only the
 * surface `room.ts` touches: `handlers`, `connect`, `close`, `createRoom`, `joinRoom`, `setReady`,
 * `startMatch`, `createRanked`, `cancelQueue`, `gateway.getState()`) and `HeadlessAppViews` for the
 * `RoomView` handle — same hand-built-AppCtx style as `lobby-feedback-nav.test.ts`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as analytics from '../src/analytics';
import { createRoomNav } from '../src/app/nav/room';
import { log } from '../src/app/appConstants';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { NetSession } from '../src/net/NetSession';
import type { NetState } from '../src/net/NetClient';
import { HeadlessAppViews } from './harness/HeadlessAppViews';
import { WorldApiClient } from '../src/net/WorldApiClient';

type FakeSession = NetSession & {
  createRoom: ReturnType<typeof vi.fn>; joinRoom: ReturnType<typeof vi.fn>; setReady: ReturnType<typeof vi.fn>;
  startMatch: ReturnType<typeof vi.fn>; createRanked: ReturnType<typeof vi.fn>; cancelQueue: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>;
};

/** Only the surface `room.ts`'s goRoom() touches on a NetSession. */
function makeFakeSession(opts: { gatewayState?: NetState } = {}): FakeSession {
  return {
    handlers: {},
    gateway: { getState: () => opts.gatewayState ?? 'idle' },
    connect: vi.fn(),
    close: vi.fn(),
    createRoom: vi.fn(),
    joinRoom: vi.fn(),
    setReady: vi.fn(),
    startMatch: vi.fn(),
    createRanked: vi.fn(),
    cancelQueue: vi.fn(),
  } as unknown as FakeSession;
}

/** Builds ctx+nav (wired to createRoomNav) but does NOT call goRoom() itself — each test drives
 *  that explicitly so it controls the exact opts (autoRanked etc.) goRoom() sees. */
function buildRoomNav(opts: { session?: FakeSession | null; deck?: string[]; api?: AppCtx['api'] | null } = {}): {
  views: HeadlessAppViews; nav: Nav; session: FakeSession | null;
} {
  const session = opts.session === undefined ? makeFakeSession() : opts.session;
  const views = new HeadlessAppViews();
  const state: AppState = {
    inLobby: true, offlineMode: false, gatewayUrl: session ? 'wss://x/gw' : null,
    netSession: null, firstLobbyHandled: true,
    socialBadgeTotal: 0, mailBadgeCount: 0, achievementClaimable: false,
    shopCardClaimable: false, achievementReached: null,
  };
  const nav = {} as Nav;
  nav.goLobby = vi.fn();
  nav.goGameNet = vi.fn();
  nav.goGame = vi.fn();

  const ctx: AppCtx = {
    platform: { storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } } as unknown as AppCtx['platform'],
    views,
    api: (opts.api === undefined ? ({} as AppCtx['api']) : opts.api) as AppCtx['api'],
    baseUrl: null,
    saveManager: {} as AppCtx['saveManager'],
    replayStore: {} as AppCtx['replayStore'],
    featureFlags: null,
    state,
    nav,
    getNetSession: () => session,
    applyGatewayUrl: () => {},
    playerName: () => 'tester',
    avatarId: () => undefined,
    gateConsent: (next) => next(),
    resolvePvpDeck: () => opts.deck ?? ['deck_card'],
    keepReplay: (r) => r,
    resolveWorldShard: () => {},
  };

  Object.assign(nav, createRoomNav(ctx));
  return { views, nav, session };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('room.ts — goRoom() basic wiring', () => {
  it('connects the gateway on entry', () => {
    const { nav, session } = buildRoomNav();
    nav.goRoom();
    expect(session!.connect).toHaveBeenCalledTimes(1);
  });

  it('createRoom(): tracks pvp_room_create(mode:friendly) and creates with the resolved deck', () => {
    const { nav, views, session } = buildRoomNav({ deck: ['a', 'b'] });
    const trackSpy = vi.spyOn(analytics, 'track');
    nav.goRoom();

    views.room!.createRoom();

    expect(trackSpy).toHaveBeenCalledWith('pvp_room_create', { mode: 'friendly' });
    expect(session!.createRoom).toHaveBeenCalledWith(['a', 'b']);
  });

  it('joinRoom(code): forwards the code and the resolved deck', () => {
    const { nav, views, session } = buildRoomNav({ deck: ['x'] });
    nav.goRoom();

    views.room!.joinRoom('ABCD');

    expect(session!.joinRoom).toHaveBeenCalledWith('ABCD', ['x']);
  });

  it('setReady/startMatch/cancelQueue forward straight to the session', () => {
    const { nav, views, session } = buildRoomNav();
    nav.goRoom();

    views.room!.setReady(true);
    views.room!.startMatch();
    views.room!.cancelQueue();

    expect(session!.setReady).toHaveBeenCalledWith(true);
    expect(session!.startMatch).toHaveBeenCalledTimes(1);
    expect(session!.cancelQueue).toHaveBeenCalledTimes(1);
  });

  it('createRanked(): tracks pvp_room_create(mode:ranked) and queues with the resolved deck', () => {
    const { nav, views, session } = buildRoomNav({ deck: ['a', 'b'] });
    const trackSpy = vi.spyOn(analytics, 'track');
    nav.goRoom();

    views.room!.createRanked();

    expect(trackSpy).toHaveBeenCalledWith('pvp_room_create', { mode: 'ranked' });
    expect(session!.createRanked).toHaveBeenCalledWith(['a', 'b']);
  });

  it('onBack(): closes the session, resets handlers to just onMatchStart, and returns to the lobby', () => {
    const { nav, views, session } = buildRoomNav();
    nav.goRoom();

    views.room!.onBack();

    expect(session!.close).toHaveBeenCalledTimes(1);
    expect(nav.goLobby).toHaveBeenCalledTimes(1);
    expect(session!.handlers.onMatchStart).toBeTypeOf('function');
    expect(session!.handlers.onRoomState).toBeUndefined(); // the room-scoped handlers are dropped
  });

  it('exposes available:false when there is no session (offline)', () => {
    const { nav, views } = buildRoomNav({ session: null });
    nav.goRoom();
    expect((views.room as unknown as { available: boolean }).available).toBe(false);
  });

  it('forwards a live room_state/room_error/peer_dc push into the RoomView handle', () => {
    const { nav, views, session } = buildRoomNav();
    nav.goRoom();

    session!.handlers.onRoomState?.({ code: 'ABCD', players: [] } as never);
    session!.handlers.onRoomError?.({ code: 'RANKED_UNAVAILABLE', message: 'no ranked server' });
    // peer_dc was named in this case's title from the start but never actually fired — the
    // 2026-09-10 FNDA sweep found `onPeerDc` at zero hits underneath a test that claims it.
    // (HeadlessAppViews.applyPeerDc was a no-op that recorded nothing, so there was also nothing
    // to assert against; it now stores the payload.) A dropped peer_dc means the opponent walks
    // out and the other player keeps waiting at a full-looking room with no grace countdown.
    session!.handlers.onPeerDc?.({ side: 1, graceMs: 30_000 });

    expect(views.lastRoomState).toEqual({ code: 'ABCD', players: [] });
    expect(views.lastRoomError).toEqual({ code: 'RANKED_UNAVAILABLE', message: 'no ranked server' });
    expect(views.lastRoomPeerDc).toEqual({ side: 1, graceMs: 30_000 });
  });

  it('a match_start push routes straight into the netplay game', () => {
    // The single most consequential handler in the file, and it had never been invoked by a test:
    // every friendly room and every ranked queue ends here. Drop it and the server starts a match
    // the client never joins — the player sits in the room UI while their opponent plays alone
    // and the ticket eventually expires.
    const { nav, session } = buildRoomNav();
    nav.goRoom();

    const info = { roomId: 'r1', gameUrl: 'wss://g/1', ticket: 't1', localSide: 0 } as never;
    session!.handlers.onMatchStart?.(info);

    expect(nav.goGameNet).toHaveBeenCalledWith(info);
  });

  it('after onBack(), the surviving onMatchStart still routes into the game', () => {
    // onBack() replaces the room-scoped handler bundle with a single onMatchStart — a SECOND
    // closure, distinct from the one above and just as untested. It is what catches the race
    // where the player backs out of the queue at the same moment matchmaking pairs them: the
    // server has already started the match, and without this the client is simply absent.
    const { nav, views, session } = buildRoomNav();
    nav.goRoom();
    views.room!.onBack();

    const info = { roomId: 'r2', gameUrl: 'wss://g/2', ticket: 't2', localSide: 1 } as never;
    session!.handlers.onMatchStart?.(info);

    expect(nav.goGameNet).toHaveBeenCalledWith(info);
  });

  it('getProfileExtra is wired to the world API and forwards the public id verbatim', async () => {
    // The room's profile popups (tap an opponent's nameplate) go through this one closure. It is
    // only present when `api` is configured, and it must pass the id straight through — a wrong
    // id shows someone else's rank/ELO/family next to this player's name, which nothing flags.
    const spy = vi.spyOn(WorldApiClient.prototype, 'getProfileExtra')
      .mockResolvedValue({ publicId: 'pub-9' } as never);
    const { nav, views } = buildRoomNav();
    nav.goRoom();

    await views.room!.getProfileExtra!('pub-9');

    expect(spy).toHaveBeenCalledWith('pub-9');
  });

  it('omits getProfileExtra entirely when there is no api (offline build)', () => {
    // Not "provides one that fails": RoomScene checks for the callback's presence to decide
    // whether nameplates are tappable at all, so an always-rejecting stub would give the player
    // a popup that spins forever.
    const { nav, views } = buildRoomNav({ api: null });
    nav.goRoom();
    expect(views.room!.getProfileExtra).toBeUndefined();
  });
});

describe('room.ts — autoRanked entry', () => {
  it('gateway already open at entry: queues ranked immediately, synchronously (no waiting for a push)', () => {
    const session = makeFakeSession({ gatewayState: 'open' });
    const { nav, views } = buildRoomNav({ session, deck: ['ranked_deck'] });
    const trackSpy = vi.spyOn(analytics, 'track');

    nav.goRoom({ autoRanked: true });

    expect(session.createRanked).toHaveBeenCalledWith(['ranked_deck']);
    expect(trackSpy).toHaveBeenCalledWith('pvp_room_create', { mode: 'ranked' });
    expect(views.lastRoomNetState).toBe('open'); // delivered synchronously since connect() is a no-op when already open
  });

  it('gateway not yet open: queues only once the "open" push arrives', () => {
    const session = makeFakeSession({ gatewayState: 'idle' });
    const { nav } = buildRoomNav({ session, deck: ['d'] });

    nav.goRoom({ autoRanked: true });
    expect(session.createRanked).not.toHaveBeenCalled();

    session.handlers.onNetState?.('open');
    expect(session.createRanked).toHaveBeenCalledTimes(1);
  });

  it('a redundant onNetState("open") after auto-queuing does not double-dispatch createRanked', () => {
    const session = makeFakeSession({ gatewayState: 'idle' });
    const { nav } = buildRoomNav({ session, deck: ['d'] });
    nav.goRoom({ autoRanked: true });

    session.handlers.onNetState?.('open');
    session.handlers.onNetState?.('open'); // fires again (e.g. a second reconnect) — must be a no-op

    expect(session.createRanked).toHaveBeenCalledTimes(1);
  });

  it('cancelQueue() clears the ranked-queued flag so a LATER onNetState("open") can re-queue', () => {
    const session = makeFakeSession({ gatewayState: 'idle' });
    const { nav, views } = buildRoomNav({ session, deck: ['d'] });
    nav.goRoom({ autoRanked: true });
    session.handlers.onNetState?.('open');
    expect(session.createRanked).toHaveBeenCalledTimes(1);

    views.room!.cancelQueue();
    session.handlers.onNetState?.('open'); // a later reconnect after cancelling should be free to re-queue

    expect(session.createRanked).toHaveBeenCalledTimes(2);
  });

  it('logs a warning instead of throwing when autoRanked is requested but there is no session', () => {
    const warnSpy = vi.spyOn(log, 'warn');
    const { nav } = buildRoomNav({ session: null });

    expect(() => nav.goRoom({ autoRanked: true })).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('room.ts — matchmaking-timeout AI fallback (onMatchBot)', () => {
  it('parses a valid AI-level string and starts a local match with fromBotFallback', () => {
    const { nav, session } = buildRoomNav();
    nav.goRoom();

    session!.handlers.onMatchBot?.(12345, 'Bot', 1000, '7');

    expect(nav.goGame).toHaveBeenCalledWith({ seed: 12345, difficulty: 7, fromBotFallback: true });
  });

  it('a malformed difficulty string omits the difficulty field entirely rather than sending NaN', () => {
    const { nav, session } = buildRoomNav();
    nav.goRoom();

    session!.handlers.onMatchBot?.(12345, 'Bot', 1000, 'not-a-number');

    expect(nav.goGame).toHaveBeenCalledWith({ seed: 12345, fromBotFallback: true });
  });

  it('resets the ranked-queued flag so a subsequent onNetState("open") can re-queue after a bot fallback', () => {
    const session = makeFakeSession({ gatewayState: 'idle' });
    const { nav } = buildRoomNav({ session, deck: ['d'] });
    nav.goRoom({ autoRanked: true });
    session.handlers.onNetState?.('open'); // queues once
    expect(session.createRanked).toHaveBeenCalledTimes(1);

    session.handlers.onMatchBot?.(1, 'Bot', 1000, '3'); // matchmaking timed out — resets rankedQueued
    session.handlers.onNetState?.('open'); // should be free to queue again now

    expect(session.createRanked).toHaveBeenCalledTimes(2);
  });
});

describe('room.ts — goDeckBuilder()', () => {
  function buildDeckBuilderNav(
    pvpDeck: string[] | null,
    elo = 1000,
  ): { nav: Nav; views: HeadlessAppViews; patchLocal: ReturnType<typeof vi.fn> } {
    const patchLocal = vi.fn();
    const views = new HeadlessAppViews();
    const nav = {} as Nav;
    nav.goLobby = vi.fn();
    const ctx: AppCtx = {
      platform: {} as AppCtx['platform'],
      views,
      api: {} as AppCtx['api'],
      baseUrl: null,
      saveManager: { get: () => ({ pvpDeck, pvp: { elo } }), patchLocal } as unknown as AppCtx['saveManager'],
      replayStore: {} as AppCtx['replayStore'],
      featureFlags: null,
      state: {} as AppState,
      nav,
      getNetSession: () => null,
      applyGatewayUrl: () => {},
      playerName: () => 'tester',
      avatarId: () => undefined,
      gateConsent: (next) => next(),
      resolvePvpDeck: () => [],
      keepReplay: (r) => r,
      resolveWorldShard: () => {},
    };
    Object.assign(nav, createRoomNav(ctx));
    return { nav, views, patchLocal };
  }

  it('persists the confirmed deck locally, then forwards it to the caller-supplied onSave', () => {
    // HeadlessAppViews.showDeckBuilder auto-confirms with the current (or default) deck — see its
    // own doc comment — so calling goDeckBuilder immediately drives the real onSave round-trip.
    const { nav, patchLocal } = buildDeckBuilderNav(['old']);
    const outerOnSave = vi.fn();

    nav.goDeckBuilder(outerOnSave);

    expect(patchLocal).toHaveBeenCalledWith({ pvpDeck: ['old'] });
    expect(outerOnSave).toHaveBeenCalledWith(['old']);
  });

  it("getCurrentElo reports the saved ranked ELO — the deck validator's only input for it", () => {
    // DeckBuilderScene calls this to run validatePvpDeckClient, i.e. to decide which cards a
    // player at this rating may field. Report a stale or default 1000 for a 1600-rated player and
    // the client either blocks a legal deck or waves through one the SERVER will reject at queue
    // time — the second one surfaces as "ranked is broken", far from this line.
    const { nav, views } = buildDeckBuilderNav(['old'], 1642);
    nav.goDeckBuilder(vi.fn());
    expect(views.deckBuilder!.getCurrentElo()).toBe(1642);
  });

  it('onBack returns to the lobby without writing the deck', () => {
    // Backing out is the "I changed my mind" path: patchLocal must NOT have run for it, or a
    // half-edited deck silently becomes the one that goes into the next ranked match.
    const { nav, views, patchLocal } = buildDeckBuilderNav(['old']);
    nav.goDeckBuilder(vi.fn());
    patchLocal.mockClear(); // showDeckBuilder auto-confirms on entry; ignore that write

    views.deckBuilder!.onBack();

    expect(nav.goLobby).toHaveBeenCalledTimes(1);
    expect(patchLocal).not.toHaveBeenCalled();
  });

  it('falls back to the default PvP deck when no deck is saved yet', () => {
    const { nav, patchLocal } = buildDeckBuilderNav(null);
    const outerOnSave = vi.fn();

    nav.goDeckBuilder(outerOnSave);

    expect(patchLocal).toHaveBeenCalled();
    expect(outerOnSave).toHaveBeenCalled();
    const saved = outerOnSave.mock.calls[0]![0] as string[];
    expect(saved.length).toBeGreaterThan(0);
  });
});
