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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// Deep-import to avoid the @nw/shared barrel, which re-exports server-only jwt.ts
// (needs `jsonwebtoken`, not installed in the client).
import { AUCTION_DURATIONS_SEC, AUCTION_TAX_RATE } from '@nw/shared/slg/auction';
import { createAppCore } from '../../src/app/createAppCore';
import { HeadlessPlatform } from '../harness/HeadlessPlatform';
import { HeadlessAppViews } from '../harness/HeadlessAppViews';

const API_BASE = process.env.NW_API_BASE ?? 'http://localhost:18080';
const EXPECT_GATEWAY = process.env.NW_EXPECT_GATEWAY ?? 'ws://localhost:8086/gw';
// Auction runs in its own service (auctionsvc, AUCTION_DESIGN §9). The client reaches /auction/*
// through getWorldBaseUrl(), which reads globalThis.__NW_WORLD_BASE__ — the auction describe below
// points it at auctionsvc for its duration. In dev-up.ps1 auctionsvc listens on 18086; in prod Caddy
// proxies same-origin /auction → auctionsvc.
const AUCTION_BASE = process.env.NW_AUCTION_BASE ?? 'http://127.0.0.1:18086';
// Seeding a seller's material inventory needs meta's internal escrow-grant endpoint (a fresh account
// owns nothing). Same X-Internal-Key the services share in dev (dev-up.ps1 → 'dev-internal-key').
const META_INTERNAL_BASE = process.env.NW_META_INTERNAL_BASE ?? API_BASE;
const INTERNAL_KEY = process.env.NW_INTERNAL_KEY ?? 'dev-internal-key';
const AUCTION_DUR = AUCTION_DURATIONS_SEC[0]!;

/** Probe: is auctionsvc up? The rest of the live stack is a hard prereq of this file, but auctionsvc
 * is an extra process (dev-up.ps1 starts it); skip just the auction block with a warning if it's down. */
async function auctionReachable(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${AUCTION_BASE}/health`, { signal: ctrl.signal });
    clearTimeout(id);
    return res.ok;
  } catch { return false; }
}
const AUCTION_UP = await auctionReachable();
if (!AUCTION_UP) {
  console.warn(`[full-link.e2e] auctionsvc unreachable (${AUCTION_BASE}) — skipping auction full-link block.`);
}

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

/** A client seeded with a prior client's full storage — simulates a same-device app
 * restart (the persisted token + save + flags survive). */
function createClientFrom(storage: Record<string, string>): Client {
  const platform = new HeadlessPlatform({ storage });
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
  c.views.consent!.onAccept(); // GDPR gate (L1-1) before entry
  await waitFor(() => c.views.screen === 'login', 'login screen');

  const loginId = uid();
  const outcome = await c.views.login!.onRegister(loginId, 'password123', name);
  expect(outcome.ok, `register failed: ${JSON.stringify(outcome)}`).toBe(true);
  await waitFor(() => c.views.screen === 'lobby', 'online lobby');
  expect(c.views.lobby!.online).toBe(true);
  return loginId;
}

/** Real login flow: intro → login → onLogin → online lobby. */
async function loginAndEnterLobby(c: Client, loginId: string, password: string): Promise<void> {
  c.core.start();
  c.views.intro!.onFinish();
  c.views.consent!.onAccept(); // GDPR gate (L1-1) before entry
  await waitFor(() => c.views.screen === 'login', 'login screen');
  const outcome = await c.views.login!.onLogin(loginId, password);
  expect(outcome.ok, `login failed: ${JSON.stringify(outcome)}`).toBe(true);
  await waitFor(() => c.views.screen === 'lobby' && c.views.lobby!.online === true, 'online lobby');
}

describe('full-link E2E (live stack)', () => {
  it('register → meta economy: recharge, shop buy, gacha draw (server-authoritative)', async () => {
    const c = createClient();
    await registerAndEnterLobby(c, 'Economy Tester');

    // Shop: real GET /shop/items (lobby entry now lands on gacha first)
    c.views.lobby!.onOpenShop();
    expect(c.views.screen).toBe('gacha');
    c.views.gacha!.openShop!();
    expect(c.views.screen).toBe('shop');
    const items = await c.views.shop!.loadItems();
    expect(items.length).toBeGreaterThan(0);

    // Virtual top-up (dev stub) → coins credited, pushed back server-authoritatively.
    // Receipt must be unique per account: rechargeVerify is globally idempotent on
    // `dev:<receipt>`, so a shared constant would dedup against other tests' accounts.
    const coinsBefore = c.views.shop!.getCoins();
    const r = await c.views.shop!.recharge!(`topup_${uid()}`);
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

  it('ranked matchmaking wires correct ports + produces a watchable replay (local + server)', async () => {
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

    // —— Server-side replay (S1-RP): the archived match is fetchable over REST,
    // its opaque base64 frames decode to a client Replay, and it plays back. This is
    // the StatsScene "watch from history" path: getMatchHistory → getMatchReplay →
    // serverReplayToReplay → ReplayInputSource. (Distinct from the local ReplayStore
    // path asserted above — here the frames came from the SERVER, not local recording.)
    a.views.lobby!.onOpenStats();
    expect(a.views.screen).toBe('stats');
    expect(a.views.stats!.loadHistory, 'logged-in stats must offer history').toBeTruthy();
    expect(a.views.stats!.onWatchReplay, 'logged-in stats must offer watch-replay').toBeTruthy();

    // The just-played ranked match is archived async on the server; poll history for it.
    let roomId = '';
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const hist = await a.views.stats!.loadHistory!();
      const entry = hist.find((h) => h.mode === 'ranked');
      if (entry) { roomId = entry.roomId; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(roomId, 'archived ranked match not found in history').toBeTruthy();

    // Fetch + decode + play the SERVER replay (fire-and-forget → navigates to replay).
    a.views.stats!.onWatchReplay!(roomId);
    await waitFor(() => a.views.screen === 'replay', 'server replay scene', 15_000);
    const srvEnd = a.views.replayEndFrame!;
    expect(srvEnd, 'server replay has no frame horizon').toBeGreaterThan(0);
    const srvTicks = a.views.driveReplayToEnd();
    expect(srvTicks, 'server replay did not advance to endFrame').toBeGreaterThanOrEqual(srvEnd);
  });

  it('account lifecycle: register → recharge → rename, then login on a fresh client restores name + coins (cloud round-trip); same-device restart re-logs in via persisted token', async () => {
    const loginId = uid();
    const pw = 'password123';
    const NEW_NAME = 'Renamed Hero';

    // ── Client A: register, recharge, rename (−500) ──
    const a = createClient();
    a.core.start();
    a.views.intro!.onFinish();
    a.views.consent!.onAccept(); // GDPR gate (L1-1) before entry
    await waitFor(() => a.views.screen === 'login', 'A login screen');
    expect((await a.views.login!.onRegister(loginId, pw, 'Original Name')).ok).toBe(true);
    await waitFor(() => a.views.screen === 'lobby' && a.views.lobby!.online === true, 'A online lobby');

    // Recharge (server-authoritative coins pushed back into the save).
    a.views.lobby!.onOpenShop();
    expect(a.views.screen).toBe('gacha');
    a.views.gacha!.openShop!();
    expect(a.views.screen).toBe('shop');
    await a.views.shop!.loadItems();
    // Unique dev receipt (see note above): the dev stub's default tier grants 550 coins (> 500 rename cost).
    expect((await a.views.shop!.recharge!(`topup_${uid()}`)).ok, 'recharge failed').toBe(true);
    const afterRecharge = a.views.shop!.getCoins();
    expect(afterRecharge, 'recharge should grant enough to rename').toBeGreaterThan(500);
    a.views.shop!.onBack();
    await waitFor(() => a.views.screen === 'lobby', 'A back to lobby');

    // Rename via settings: costs 500 coins (commercial spend → meta rename → mirrored back to client).
    a.views.lobby!.onOpenProfile();
    expect(a.views.screen).toBe('settings');
    expect(a.views.settings!.renameCost).toBe(500);
    const rn = await a.views.settings!.onRename!(NEW_NAME);
    expect(rn.ok, `rename failed: ${JSON.stringify(rn)}`).toBe(true);
    expect(a.views.settings!.getCoins!(), 'rename should deduct exactly 500').toBe(afterRecharge - 500);
    const expectedCoins = afterRecharge - 500;

    // ── Client B: fresh device, log in with the SAME account ──
    // Proves login + that recharge/rename round-tripped through the cloud.
    const b = createClient();
    await loginAndEnterLobby(b, loginId, pw);
    // displayName recovered from the server (historically showed "guest" placeholder).
    await waitFor(() => b.views.lobby?.playerName === NEW_NAME, 'B name restored from cloud', 15_000);
    // Server-authoritative coins restored from cloud.
    b.views.lobby!.onOpenShop();
    b.views.gacha!.openShop!();
    await b.views.shop!.loadItems();
    await waitFor(() => b.views.shop!.getCoins() === expectedCoins, 'B coins restored from cloud', 15_000);

    // ── Same-device restart: new core on A's persisted storage → re-logs in via the
    //    saved token (bootstrap), lands in the online lobby with no credentials. ──
    const restart = createClientFrom(a.platform.snapshotStorage());
    restart.core.start();
    await waitFor(
      () => restart.views.screen === 'lobby' && restart.views.lobby!.online === true,
      'restart online lobby via persisted token',
      15_000,
    );
    await waitFor(() => restart.views.lobby?.playerName === NEW_NAME, 'restart name from token re-login', 15_000);
  });

  it('friendly room: A creates a room, B joins by code, both ready → auto-start into a netplay match', async () => {
    const a = createClient();
    const b = createClient();
    await registerAndEnterLobby(a, 'Host');
    await registerAndEnterLobby(b, 'Guest');

    // A opens the room and creates one once the gateway WS is open.
    a.views.lobby!.onOpenRoom();
    expect(a.views.screen).toBe('room');
    await waitFor(() => a.views.lastRoomNetState === 'open', 'A gateway open', 15_000);
    a.views.room!.createRoom();
    await waitFor(() => !!a.views.lastRoomState?.code, 'A room code assigned', 15_000);
    const code = a.views.lastRoomState!.code;
    expect(code.length).toBeGreaterThan(0);

    // B opens the room and joins by that code.
    b.views.lobby!.onOpenRoom();
    await waitFor(() => b.views.lastRoomNetState === 'open', 'B gateway open', 15_000);
    b.views.room!.joinRoom(code);
    await waitFor(
      () => (a.views.lastRoomState?.players.length ?? 0) >= 2 && (b.views.lastRoomState?.players.length ?? 0) >= 2,
      'both players in room',
      15_000,
    );

    // Both ready → matchsvc auto-starts the friendly match (no host start click needed).
    a.views.room!.setReady(true);
    b.views.room!.setReady(true);
    await waitFor(() => a.views.screen === 'gameNet' && b.views.screen === 'gameNet', 'both matched (friendly)', 25_000);

    // Data plane wired with a signed ticket, same as ranked.
    expect(a.platform.openedSockets.find((u) => u.includes('ticket=')), 'no ticketed game socket (friendly)').toBeTruthy();

    // Lockstep advances, then clean up.
    const [tA, tB] = await Promise.all([a.views.driveFor(1500), b.views.driveFor(1500)]);
    expect(tA, 'client A lockstep did not advance').toBeGreaterThan(0);
    expect(tB, 'client B lockstep did not advance').toBeGreaterThan(0);
    a.views.gameNet!.cb.onExitToLobby();
    b.views.gameNet!.cb.onExitToLobby();
    await waitFor(() => a.views.screen === 'lobby' && b.views.screen === 'lobby', 'back to lobby');
  });

  it('negative paths: duplicate loginId is rejected; a broke account cannot buy', async () => {
    const loginId = uid();
    const pw = 'password123';

    // First registration succeeds.
    const a = createClient();
    a.core.start();
    a.views.intro!.onFinish();
    a.views.consent!.onAccept(); // GDPR gate (L1-1) before entry
    await waitFor(() => a.views.screen === 'login', 'A login screen');
    expect((await a.views.login!.onRegister(loginId, pw, 'First')).ok).toBe(true);
    await waitFor(() => a.views.screen === 'lobby', 'A online lobby');

    // Second registration with the SAME loginId is rejected; the client stays on login.
    const b = createClient();
    b.core.start();
    b.views.intro!.onFinish();
    b.views.consent!.onAccept(); // GDPR gate (L1-1) before entry
    await waitFor(() => b.views.screen === 'login', 'B login screen');
    const dup = await b.views.login!.onRegister(loginId, pw, 'Second');
    expect(dup.ok, 'duplicate loginId should be rejected').toBe(false);
    expect(b.views.screen).toBe('login');

    // Fresh accounts start at 0 coins → buying the cheapest shop item fails (INSUFFICIENT_FUNDS).
    a.views.lobby!.onOpenShop();
    a.views.gacha!.openShop!();
    const items = await a.views.shop!.loadItems();
    expect(items.length).toBeGreaterThan(0);
    expect(a.views.shop!.getCoins()).toBe(0);
    const buy = await a.views.shop!.buy(items[0].id);
    expect(buy.ok, 'broke account should not be able to buy').toBe(false);
  });
});

// ── Auction full-link (live auctionsvc) ───────────────────────────────────────────────────────────
// The auctionsvc-local e2e (server/auctionsvc/test/auction-fulllink.e2e.test.ts) already drives the
// real WorldApiClient against an ad-hoc auctionsvc with stubbed downstreams and a hand-signed JWT.
// This block closes the last gap: the REAL app core (createAppCore → goAuctionFromLobby builds the
// WorldApiClient from the signed-in platform.storage token) → real HTTP → the LIVE auctionsvc →
// its real cross-service calls (commercial coins / meta materials / system mail). It proves the
// production base-URL resolution + real login token + envelope/DTO contract all line up end-to-end.
describe.skipIf(!AUCTION_UP)('auction full-link (real app core → live auctionsvc)', () => {
  // Point the client's world/auction base at auctionsvc for this block only; restore after so the
  // rest of the file (which never touches the world base) is unaffected.
  let prevWorldBase: string | undefined;
  beforeAll(() => {
    const g = globalThis as { __NW_WORLD_BASE__?: string };
    prevWorldBase = g.__NW_WORLD_BASE__;
    g.__NW_WORLD_BASE__ = AUCTION_BASE;
  });
  afterAll(() => {
    const g = globalThis as { __NW_WORLD_BASE__?: string };
    if (prevWorldBase === undefined) delete g.__NW_WORLD_BASE__;
    else g.__NW_WORLD_BASE__ = prevWorldBase;
  });

  /** Seed a seller's material inventory via meta's internal escrow-grant (fresh accounts own none). */
  async function seedMaterial(accountId: string, material: string, qty: number): Promise<void> {
    const res = await fetch(`${META_INTERNAL_BASE}/internal/materials/grant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_KEY },
      body: JSON.stringify({ accountId, material, qty, orderId: `e2e_seed_${uid()}` }),
    });
    if (!res.ok) throw new Error(`meta material grant failed (${res.status}) — is NW_INTERNAL_KEY correct?`);
  }

  /** Open the auction house from the lobby the way a player taps it; returns the captured live WorldApiClient. */
  async function enterAuction(c: Client): Promise<import('../../src/net/WorldApiClient').WorldApiClient> {
    // onOpenAuction is optional in the lobby callback type (only wired when online); asserted online in setup.
    c.views.lobby!.onOpenAuction!();
    await waitFor(() => c.views.screen === 'auction' && !!c.views.auction, 'auction scene + captured callbacks');
    return c.views.auction!.worldApi;
  }

  it('material listing round-trips create → mine → list → buy through the real client core, and a bad request surfaces as a typed WorldApiError', async () => {
    const seller = createClient();
    const buyer = createClient();
    await registerAndEnterLobby(seller, 'Auction Seller');
    await registerAndEnterLobby(buyer, 'Auction Buyer');

    // Seed the seller with materials to list (scrap ref=10 → guardrail band [5,20]).
    // accountId is the authoritative cloud-save identity persisted in the local save
    // (nw_save_v1) — the same source the app itself reads via saveManager.get().accountId.
    const sellerSave = seller.platform.storage.getItem('nw_save_v1');
    const sellerAcct = sellerSave ? (JSON.parse(sellerSave).accountId as string) : '';
    expect(sellerAcct, 'seller account id persisted after register').toBeTruthy();
    await seedMaterial(sellerAcct, 'scrap', 5);

    // Buyer needs coins (auction buy deducts via commercial) — real dev top-up (grants 550).
    buyer.views.lobby!.onOpenShop();
    buyer.views.gacha!.openShop!();
    await buyer.views.shop!.loadItems();
    expect((await buyer.views.shop!.recharge!(`topup_${uid()}`)).ok, 'buyer recharge').toBe(true);
    buyer.views.shop!.onBack();
    await waitFor(() => buyer.views.screen === 'lobby', 'buyer back to lobby');

    // Seller lists over the real wire (unit price 10 × qty 2 = 20).
    const sellerApi = await enterAuction(seller);
    const view = await sellerApi.createAuction('material', { material: 'scrap' }, 2, AUCTION_DUR, { price: 10 });
    expect(view.auctionId).toBeTruthy();
    expect(view.status).toBe('open');
    expect(view.itemType).toBe('material');
    expect(view.qty).toBe(2);
    expect(view.totalPrice).toBe(20);
    // seller's "mine" tab sees it; buyer's does not.
    expect((await sellerApi.getMyListings()).some((a) => a.auctionId === view.auctionId)).toBe(true);

    // Buyer sees it on the public market and buys it.
    const buyerApi = await enterAuction(buyer);
    expect((await buyerApi.listAuctions({ itemType: 'material' })).some((a) => a.auctionId === view.auctionId)).toBe(true);
    expect(await buyerApi.getMyListings()).toHaveLength(0);
    await buyerApi.buyAuction(view.auctionId); // resolves ⇒ coins deducted, seller paid net of tax, item mailed (all live)
    void AUCTION_TAX_RATE; // (tax split asserted in the service-layer e2e; here we prove the wire round-trips)
    // …and it's gone from the open market.
    expect((await buyerApi.listAuctions({ itemType: 'material' })).some((a) => a.auctionId === view.auctionId)).toBe(false);

    // Error envelope over the LIVE wire: buying your own listing → BAD_REQUEST mapped to a typed
    // WorldApiError (regression guard for the task-9 { ok:false, error:{ code } } unwrap fix).
    const v2 = await sellerApi.createAuction('material', { material: 'scrap' }, 1, AUCTION_DUR, { price: 10 });
    await expect(sellerApi.buyAuction(v2.auctionId)).rejects.toMatchObject({ name: 'WorldApiError', code: 'BAD_REQUEST' });
  });
});
