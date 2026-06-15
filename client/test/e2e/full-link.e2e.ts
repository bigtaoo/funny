// Full-link E2E — drives the REAL client orchestration core (createAppCore) in
// Node, with no rendering, against a live local server stack. The point is to
// catch breakage server-only tests can't see: did the client call the RIGHT ports
// in the RIGHT order — register/login/economy over meta REST, rooms/matchmaking
// over the SERVER-PROVIDED gateway WS, and the lockstep data plane over the
// match_found-delivered game WS with a ?ticket= ?
//
// Prereq: a running stack. Locally: `npm run dev:all` in server/ (dev-up.ps1).
// Endpoints via env (defaults match dev-up.ps1):
//   NW_API_BASE         meta REST base         (default http://localhost:18080)
//   NW_EXPECT_GATEWAY   gateway WS the server should hand back (default ws://localhost:8086/gw)
//
// Run: npm run test:e2e   (NOT part of `npm test`).

import { describe, it, expect } from 'vitest';
import { createAppCore } from '../../src/app/createAppCore';
import { HeadlessPlatform } from '../harness/HeadlessPlatform';
import { HeadlessAppViews } from '../harness/HeadlessAppViews';

const API_BASE = process.env.NW_API_BASE ?? 'http://localhost:18080';
const EXPECT_GATEWAY = process.env.NW_EXPECT_GATEWAY ?? 'ws://localhost:8086/gw';

interface Client {
  platform: HeadlessPlatform;
  views: HeadlessAppViews;
  core: ReturnType<typeof createAppCore>;
}

function createClient(): Client {
  const platform = new HeadlessPlatform({ storage: { nw_api_base: API_BASE } });
  const views = new HeadlessAppViews();
  const core = createAppCore(platform, views);
  return { platform, views, core };
}

/** Poll until `cond()` is truthy or timeout; throws a labelled error on timeout. */
async function waitFor(cond: () => boolean, label: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const uid = (): string => `e2e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

/** Real register flow through the core: intro → login → register → online lobby. */
async function registerAndEnterLobby(c: Client, name: string): Promise<string> {
  c.core.start();
  expect(c.views.screen).toBe('intro');
  c.views.intro!.onFinish();
  await waitFor(() => c.views.screen === 'login', 'login screen');

  const loginId = uid();
  const outcome = await c.views.login!.onRegister(loginId, 'password123', name);
  expect(outcome.ok, `register failed: ${JSON.stringify(outcome)}`).toBe(true);
  await waitFor(() => c.views.screen === 'lobby', 'online lobby');
  expect(c.views.lobby!.online).toBe(true);
  return loginId;
}

describe('full-link E2E (live stack)', () => {
  it('register → meta economy: recharge, shop buy, gacha draw (server-authoritative)', async () => {
    const c = createClient();
    await registerAndEnterLobby(c, 'Economy Tester');

    // Shop: real GET /shop/items
    c.views.lobby!.onOpenShop();
    expect(c.views.screen).toBe('shop');
    const items = await c.views.shop!.loadItems();
    expect(items.length).toBeGreaterThan(0);

    // Virtual top-up (dev stub) → coins credited, server-authoritative回推.
    const coinsBefore = c.views.shop!.getCoins();
    const r = await c.views.shop!.recharge('taowang');
    expect(r.ok, `recharge failed: ${JSON.stringify(r)}`).toBe(true);
    expect(c.views.shop!.getCoins()).toBeGreaterThan(coinsBefore);

    // Buy the first item — wallet/inventory come back from the server.
    const buy = await c.views.shop!.buy(items[0].id);
    expect(buy.ok, `buy failed: ${JSON.stringify(buy)}`).toBe(true);

    // Gacha: real pools + a single draw (atomic on the server).
    c.views.shop!.openGacha();
    expect(c.views.screen).toBe('gacha');
    const pools = await c.views.gacha!.loadPools();
    expect(pools.length).toBeGreaterThan(0);
    const draw = await c.views.gacha!.draw(pools[0].id, 1);
    expect(draw.ok, `draw failed: ${JSON.stringify(draw)}`).toBe(true);
    expect(draw.ok && draw.results.length).toBe(1);
  });

  it('ranked matchmaking wires correct ports + the match produces a watchable replay', async () => {
    const a = createClient();
    const b = createClient();

    await registerAndEnterLobby(a, 'Player A');
    await registerAndEnterLobby(b, 'Player B');

    // Both queue for ranked → RoomScene (searching) → server pairs → match_found.
    // onStartRanked is optional in the callback type (only set when online); both
    // lobbies asserted online above, so it is present here.
    a.views.lobby!.onStartRanked!();
    b.views.lobby!.onStartRanked!();
    await waitFor(() => a.views.screen === 'room' && b.views.screen === 'room', 'both in room');

    // The control-plane WS must use the address the SERVER handed back (gateway
    // port), NOT the meta REST base or a wrong build-time fallback.
    const gwA = a.platform.openedSockets.find((u) => u.includes('/gw'));
    expect(gwA, 'no gateway socket opened').toBeTruthy();
    expect(gwA!.startsWith(EXPECT_GATEWAY)).toBe(true);
    expect(gwA!.includes('token=')).toBe(true);
    expect(gwA!.includes(':18080')).toBe(false); // must not be the meta base

    // Pairing → match_found → data-plane game WS connected with a signed ticket.
    await waitFor(
      () => a.views.screen === 'gameNet' && b.views.screen === 'gameNet',
      'both matched into a netplay game',
      25_000,
    );
    const gameA = a.platform.openedSockets.find((u) => u.includes('ticket='));
    expect(gameA, 'no ticketed game socket opened').toBeTruthy();
    expect(gameA!.startsWith('ws')).toBe(true);

    // Lockstep data plane is live: driving both engines advances confirmed frames
    // (single-process can't assert a deterministic winner — see CLAUDE.md
    // two-engine id-counter note — so we assert the metronome/frames flow).
    const [ticksA, ticksB] = await Promise.all([a.views.driveFor(2500), b.views.driveFor(2500)]);
    expect(ticksA, 'client A lockstep did not advance').toBeGreaterThan(0);
    expect(ticksB, 'client B lockstep did not advance').toBeGreaterThan(0);

    // —— Replay: a real netplay match must produce a watchable, replayable recording ——
    // End the match the way the GameScene does when its engine reaches game over:
    // both clients report a result. The server (ranked) ends the match and pushes
    // match_over to both → the app snapshots the RecordingInputSource that wrapped the
    // LIVE confirmed-frame stream into a Replay, persists it, and shows the result.
    a.views.gameNet!.cb.onGameEnd(0, a.views.matchEngine!.state.snapshotStats());
    b.views.gameNet!.cb.onGameEnd(0, b.views.matchEngine!.state.snapshotStats());

    await waitFor(() => a.views.screen === 'result', 'client A result screen', 15_000);

    // The result must offer a replay (built end-to-end from the recorded frames)…
    expect(a.views.result!.cb.onWatchReplay, 'no replay offered on result').toBeTruthy();
    // …and it must have landed in the local ReplayStore (key nw_replays_v1).
    expect(a.platform.storage.getItem('nw_replays_v1'), 'replay not persisted').toBeTruthy();

    // Watch it: enter the replay scene and drive the ReplayInputSource-fed engine.
    // It re-runs the recorded netplay frames and advances to the recorded end —
    // proving the record → snapshot → store → playback loop round-trips.
    a.views.result!.cb.onWatchReplay!();
    expect(a.views.screen).toBe('replay');
    const endFrame = a.views.replayEndFrame!;
    expect(endFrame, 'replay has no recorded frames').toBeGreaterThan(0);
    const replayedTicks = a.views.driveReplayToEnd();
    expect(replayedTicks, 'replay did not advance to endFrame').toBeGreaterThanOrEqual(endFrame);

    // Clean up: leave the match (closes both NetSessions / sockets).
    a.views.gameNet!.cb.onExitToLobby();
    b.views.gameNet!.cb.onExitToLobby();
    await waitFor(() => a.views.screen === 'lobby' && b.views.screen === 'lobby', 'back to lobby');
  });
});
