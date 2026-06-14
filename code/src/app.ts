import * as PIXI from 'pixi.js-legacy';
import { IPlatform } from './platform/IPlatform';
import { SceneManager } from './scenes/SceneManager';
import { IntroScene } from './scenes/IntroScene';
import { LobbyScene } from './scenes/LobbyScene';
import { GameScene } from './scenes/GameScene';
import { RoomScene } from './scenes/RoomScene';
import { ShopScene } from './scenes/ShopScene';
import { GachaScene } from './scenes/GachaScene';
import { LoginScene, type AuthOutcome } from './scenes/LoginScene';
import { ResultScene, type EloResult } from './scenes/ResultScene';
import { ReplayScene } from './scenes/ReplayScene';
import { OwnerId, PlayerStats } from './game/types';
import { getLevel, CAMPAIGN_LEVEL_ORDER, createGameEngine, ownerToSide } from './game';
import type { MatchStartInfo, Replay } from './game';
import { ScalingManager, createLayout } from './layout/ScalingManager';
import { InputManager } from './inputSystem/InputManager';
import type { ILayout } from './layout/ILayout';
import { initI18n, type TranslationKey } from './i18n';
import { LocalSaveStore, SaveManager, ReplayStore } from './game/meta';
import { ApiClient, ApiError, type AuthResult } from './net/ApiClient';
import { getApiBaseUrl, getGatewayWsUrl } from './net/config';
import { NetSession } from './net/NetSession';
import { matchStateHash } from './net/judgeRunner';
import { MatchMode } from './net/proto/transport';
import { setBakeRenderer } from './render/bake';

/** flags key — set after the first-launch intro has been seen (was the standalone nw_seen_intro key). */
const SEEN_INTRO_FLAG = 'seen_intro';

/** Persisted JWT for a real (non-anonymous) account, so logins survive restarts (SA-3 §5). */
const TOKEN_KEY = 'nw_token';

export async function startApp(platform: IPlatform): Promise<void> {
  // i18n must be ready before any scene builds its texts
  initI18n(platform.getLanguage(), platform.storage, platform.supportedLocales);

  // ── SaveManager (S0): local-first save + optional cloud sync ────────────────
  const baseUrl = getApiBaseUrl(platform.storage);
  const api = baseUrl ? new ApiClient(baseUrl) : undefined;
  const saveManager = new SaveManager({
    store: new LocalSaveStore(platform.storage),
    api,
    getCredential: () => platform.getAuthCredential(),
  });
  // Cloud sync is offline-first and non-blocking; the entry gating (resolveEntry,
  // after intro) decides whether to bootstrap silently (wx / persisted token) or
  // show the login screen (SA-3).

  // ── ReplayStore (S1-RP): local ring of recent recorded matches ──────────────
  const replayStore = new ReplayStore(platform.storage);

  // ── NetSession (S1 / S1-M): online room + lockstep transport ────────────────
  // Three-channel topology (M20): rooms/matchmaking over the gateway control-plane
  // WS; the game data-plane WS address arrives per-match in match_found. Built only
  // when both a REST base (JWT auth) and a gateway endpoint are configured;
  // otherwise the room UI still opens but actions show "unavailable".
  const gatewayUrl = getGatewayWsUrl(platform.storage);
  let netSession: NetSession | null = null;
  function getNetSession(): NetSession | null {
    if (netSession) return netSession;
    if (!api || !gatewayUrl) return null;
    netSession = new NetSession(platform, gatewayUrl, api, () => platform.getAuthCredential());
    netSession.handlers.onMatchStart = (info) => goGameNet(info);
    return netSession;
  }

  const { width: screenW, height: screenH } = platform.getScreenSize();

  const app = new PIXI.Application({
    width:           screenW,
    height:          screenH,
    backgroundColor: 0xf5f0e8,
    view:            platform.getCanvas(),
    antialias:       false,
    resolution:      platform.devicePixelRatio,
    autoDensity:     true,
  });

  // Procedural art (sketch.ts) bakes static board layers to textures via this renderer.
  setBakeRenderer(app.renderer);

  // ── ScalingManager ────────────────────────────────────────────────────────
  let layout: ILayout = createLayout(screenW, screenH);
  const scaling = new ScalingManager(app, layout);
  const manager = new SceneManager(app, scaling.gameLayer);

  // ── InputManager ──────────────────────────────────────────────────────────
  const input = new InputManager();
  platform.setupInput(app, input, (sx, sy) => scaling.toDesignSpace(sx, sy));

  platform.onAppReady();
  await platform.onLoadingComplete();

  // ── Resize (lobby only) ───────────────────────────────────────────────────
  let inLobby = false;

  const onResize = (): void => {
    if (!inLobby) return;
    const w = platform.getScreenSize().width;
    const h = platform.getScreenSize().height;
    app.renderer.resize(w, h);
    layout = createLayout(w, h);
    scaling.resize(w, h, layout);
    goLobby();
  };

  // ── Navigation ────────────────────────────────────────────────────────────

  // SA-4: offline single-player — online entries (room / shop) route to login.
  let offlineMode = false;

  function goIntro(): void {
    inLobby = false;
    manager.goto(new IntroScene(layout, input, {
      onFinish() {
        saveManager.setFlag(SEEN_INTRO_FLAG, true);
        void resolveEntry();
      },
    }));
  }

  function goLobby(opts?: { offline?: boolean }): void {
    if (opts?.offline !== undefined) offlineMode = opts.offline;
    inLobby = true;
    platform.onGameplayStop();
    const pvp = saveManager.get().pvp;
    const loggedIn = !offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    manager.goto(new LobbyScene(layout, input, {
      onStartGame(_opponentName: string) { goGame(); },
      onStartCampaign(levelIndex: number) { goCampaign(CAMPAIGN_LEVEL_ORDER[levelIndex]); },
      onOpenRoom() { goRoom(); },
      onOpenShop() { goShop(); },
      pvp: { rank: pvp.rank, elo: pvp.elo },
      offline: offlineMode,
      onLogin: () => goLogin(),
      onLogout: loggedIn ? () => doLogout() : undefined,
    }));
    window.addEventListener('resize', onResize);
  }

  // SA-3: login screen + entry gating + persistent token.
  function goLogin(): void {
    inLobby = false;
    window.removeEventListener('resize', onResize);
    manager.goto(new LoginScene(layout, input, {
      onPlayOffline() { goLobby({ offline: true }); },
      onLogin: (loginId, password) => doAuth(() => api!.login(loginId, password)),
      onRegister: (loginId, password, displayName) =>
        doAuth(() => api!.register(loginId, password, displayName)),
    }));
  }

  /** Run a login/register call; on success persist token, reconcile, enter lobby. */
  async function doAuth(call: () => Promise<AuthResult>): Promise<AuthOutcome> {
    if (!api) {
      console.error('[auth] no API base configured (__NW_API_BASE__ empty) — request not sent');
      return { ok: false, errorKey: 'auth.err.network', detail: 'API base not configured' };
    }
    try {
      const res = await call();
      platform.storage.setItem(TOKEN_KEY, res.token);
      // Merge single-player progress into the cloud account (§4.4): pull + reconcile.
      await saveManager.adoptSession(res.accountId);
      goLobby({ offline: false });
      return { ok: true };
    } catch (e) {
      console.error('[auth] request failed', e);
      const detail =
        e instanceof ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
      return { ok: false, errorKey: mapAuthError(e), detail };
    }
  }

  function doLogout(): void {
    platform.storage.removeItem(TOKEN_KEY);
    api?.setToken(null);
    goLogin();
  }

  /**
   * Entry gating after intro (SA-3 §4.1):
   *   wx platform        → silent wx.login (A6), straight to lobby.
   *   no server / API    → offline single-player lobby.
   *   persisted token    → reuse the session (pull + reconcile), straight to lobby.
   *   otherwise          → login screen.
   */
  async function resolveEntry(): Promise<void> {
    let cred: { kind: string } | null = null;
    try { cred = await platform.getAuthCredential(); } catch { cred = null; }
    if (cred?.kind === 'wx') {
      void saveManager.bootstrap();
      goLobby({ offline: false });
      return;
    }
    if (!api) { goLobby({ offline: true }); return; }
    const token = platform.storage.getItem(TOKEN_KEY);
    if (token) {
      api.setToken(token);
      // Optimistic: enter lobby online; pull/reconcile runs in the background and
      // swallows failures (offline-first). An invalid token degrades to read-only
      // local until the next explicit login.
      void saveManager.adoptSession(saveManager.get().accountId);
      goLobby({ offline: false });
      return;
    }
    goLogin();
  }

  function goRoom(): void {
    inLobby = false;
    window.removeEventListener('resize', onResize);
    const session = getNetSession();
    const scene = new RoomScene(layout, input, {
      available: session !== null,
      onBack() {
        session?.close();
        if (session) session.handlers = { onMatchStart: (info) => goGameNet(info) };
        goLobby();
      },
      createRoom() { session?.createRoom(); },
      joinRoom(code: string) { session?.joinRoom(code); },
      setReady(ready: boolean) { session?.setReady(ready); },
      startMatch() { session?.startMatch(); },
      createRanked() { session?.createRanked(); },
      cancelQueue() { session?.cancelQueue(); },
    });

    if (session) {
      // Route server room events to the live scene; keep onMatchStart on app.
      session.handlers = {
        onMatchStart: (info) => goGameNet(info),
        onRoomState: (s) => scene.applyRoomState(s),
        onRoomError: (e) => scene.applyRoomError(e),
        onPeerDc:    (p) => scene.applyPeerDc(p),
        onNetState:  (s) => scene.applyNetState(s),
      };
      session.connect();
    }

    manager.goto(scene);
  }

  // Shop (S2-6): server-authoritative economy. Every buy/top-up returns a fresh
  // SaveData that we adopt; the scene reads wallet/inventory from SaveManager.
  // Reached only when online (api + token); the lobby routes the shop nav slot to
  // login while offline.
  function goShop(): void {
    if (!api) { goLobby(); return; }
    const client = api; // narrowed; closures below capture it as ApiClient
    inLobby = false;
    window.removeEventListener('resize', onResize);
    manager.goto(new ShopScene(layout, input, {
      onBack() { goLobby(); },
      getCoins: () => saveManager.get().wallet.coins,
      getOwnedSkins: () => saveManager.get().inventory.skins,
      loadItems: () => client.getShopItems(),
      async buy(itemId) {
        try {
          const { save } = await client.shopBuy(itemId);
          saveManager.adoptServer(save);
          return { ok: true };
        } catch (e) {
          return {
            ok: false,
            key: e instanceof ApiError && e.code === 'INSUFFICIENT_FUNDS'
              ? 'shop.insufficient' : 'shop.error',
          };
        }
      },
      async recharge(code) {
        // Virtual top-up entry (dev): a magic code maps to an IAP tier and credits
        // coins via the server's dev stub. A fresh platform tag per call keeps the
        // receiptId unique so repeated top-ups each grant. Real platform SDK on launch.
        const tier = rechargeTier(code);
        if (!tier) return { ok: false, key: 'shop.rechargeFail' };
        try {
          const { save, granted } = await client.iapVerify(`dev-${Date.now()}`, `tier:${tier}`);
          saveManager.adoptServer(save);
          return { ok: true, coins: granted };
        } catch {
          return { ok: false, key: 'shop.rechargeFail' };
        }
      },
      openGacha() { goGacha(); },
    }));
  }

  function goGacha(): void {
    if (!api) { goLobby(); return; }
    const client = api; // narrowed; closures below capture it as ApiClient
    inLobby = false;
    window.removeEventListener('resize', onResize);
    manager.goto(new GachaScene(layout, input, {
      onBack() { goShop(); },
      getCoins: () => saveManager.get().wallet.coins,
      getPity: (poolId) => saveManager.get().gacha.pity[poolId] ?? 0,
      loadPools: () => client.getGachaPools(),
      async draw(poolId, count) {
        try {
          const { save, results } = await client.gachaDraw(poolId, count);
          saveManager.adoptServer(save);
          return { ok: true, results };
        } catch (e) {
          return {
            ok: false,
            key: e instanceof ApiError && e.code === 'INSUFFICIENT_FUNDS'
              ? 'gacha.insufficient' : 'gacha.error',
          };
        }
      },
    }));
  }

  /** Persist a just-finished local match's recording; returns it for the result screen. */
  function keepReplay(replay: Replay | undefined): Replay | undefined {
    if (!replay) return undefined;
    try {
      replayStore.save(replay, replay.meta?.recordedAt ?? Date.now());
    } catch { /* storage full / unavailable — replay still watchable this session */ }
    return replay;
  }

  function goGame(): void {
    inLobby = false;
    window.removeEventListener('resize', onResize);
    platform.onGameplayStart();
    manager.goto(new GameScene(layout, input, {
      onGameEnd(winner, stats, replay) {
        goResult(winner, stats, 0, keepReplay(replay));
      },
      onExitToLobby() { goLobby(); },
    }));
  }

  function goCampaign(levelId: string | undefined): void {
    const level = levelId ? getLevel(levelId) : null;
    if (!level) { goLobby(); return; }
    inLobby = false;
    window.removeEventListener('resize', onResize);
    platform.onGameplayStart();
    manager.goto(new GameScene(layout, input, {
      onGameEnd(winner, stats, replay) {
        goResult(winner, stats, 0, keepReplay(replay));
      },
      onExitToLobby() { goLobby(); },
    }, { level }));
  }

  // Replay playback (S1-RP): spectator GameRenderer driven by a ReplayInputSource.
  function goReplay(replay: Replay): void {
    inLobby = false;
    window.removeEventListener('resize', onResize);
    platform.onGameplayStart();
    manager.goto(new ReplayScene(layout, input, replay, {
      onExit() { goLobby(); },
    }));
  }

  // Online lockstep match (S1-8 / S1-9): the engine is built from the server's
  // match_start (seed/mode) and driven by NetSession's NetInputSource. The
  // render layout is built for *this client's* side, so the joiner (localSide 1)
  // gets a 180°-flipped board with their own base / hand / HUD at the bottom.
  function goGameNet(info: MatchStartInfo): void {
    const session = netSession;
    if (!session) { goLobby(); return; }
    inLobby = false;
    window.removeEventListener('resize', onResize);
    platform.onGameplayStart();

    const localOwner = info.localSide as OwnerId;
    const side       = ownerToSide(localOwner);
    const { width, height } = platform.getScreenSize();
    const netLayout  = createLayout(width, height, side);

    const engine = createGameEngine(
      { seed: info.seed, players: [{ id: 0 }, { id: 1 }], mode: 'netplay' },
      session.input,
    );

    // Ranked needs the server-authoritative ELO (arrives in match_over) before
    // showing the result. Friendly shows the result immediately on local end.
    const isRanked = info.mode === MatchMode.RANKED;
    let netResultShown = false;
    let lastElo: EloResult | undefined;
    let pending: { winner: OwnerId | null; stats: [PlayerStats, PlayerStats] } | null = null;
    let eloWaitTimer: ReturnType<typeof setTimeout> | null = null;
    const finishNet = (
      winner: OwnerId | null,
      stats: [PlayerStats, PlayerStats],
      elo?: EloResult,
    ): void => {
      if (netResultShown) return;
      netResultShown = true;
      if (eloWaitTimer) { clearTimeout(eloWaitTimer); eloWaitTimer = null; }
      // ranked 局末 gameserver 已写 saves.pvp（elo/rank/streak）→ 拉一次刷新本地，
      // 让大厅段位徽章即时反映新分（reconcile 取云端权威段）。
      if (isRanked) void saveManager.refresh();
      void goResult(winner, stats, localOwner, undefined, elo);
    };

    const scene = new GameScene(netLayout, input, {
      onGameEnd(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]) {
        // S1-5: report end-state hash + claimed winner (ranked needs the winner;
        // server settles ELO only when both clients agree on hash + winner).
        session.reportResult(matchStateHash(winner, stats), winner ?? 0);
        if (isRanked) {
          // Hold the result until the server's match_over (ELO) arrives; if the
          // server is silent, fall back after 6s and show without ELO.
          pending = { winner, stats };
          eloWaitTimer = setTimeout(() => finishNet(winner, stats, lastElo), 6000);
        } else {
          finishNet(winner, stats);
        }
      },
      // Server-driven end (opponent timeout / desync) — no hash to report.
      onNetMatchOver(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]) {
        finishNet(winner, stats, lastElo);
      },
      onExitToLobby() { session.close(); goLobby(); },
    }, { engine, net: true });

    // Route server room/net events to the live game scene's status overlay; the
    // session keeps feeding frame_batch to its NetInputSource regardless. Keep
    // onMatchStart so a late re-fire can't strand us.
    session.handlers = {
      onMatchStart: (i) => goGameNet(i),
      onNetState:   (s) => scene.applyNetState(s),
      onPeerDc:     (p) => scene.applyPeerDc(p),
      onMatchOver:  (m) => {
        lastElo = m.elo ? { delta: m.elo.delta, after: m.elo.after, rankAfter: m.elo.rankAfter } : undefined;
        scene.applyMatchOver(m); // may fire onNetMatchOver (server-driven end)
        // Base-win path: local end already fired onGameEnd and is waiting on ELO.
        if (pending) finishNet(pending.winner, pending.stats, lastElo);
      },
    };

    manager.goto(scene);
  }

  async function goResult(
    winner: OwnerId | null,
    stats: [PlayerStats, PlayerStats],
    localOwner: OwnerId = 0,
    replay?: Replay,
    elo?: EloResult,
  ): Promise<void> {
    inLobby = false;
    platform.onGameplayStop();
    await platform.showMidgameAd();
    manager.goto(new ResultScene(layout.designWidth, layout.designHeight, winner, stats, {
      onPlayAgain() { goLobby(); },
      // Offer "watch replay" only for locally-recorded matches.
      ...(replay ? { onWatchReplay: () => goReplay(replay) } : {}),
    }, localOwner, elo));
  }

  // First launch → background-story intro; afterwards the entry gating decides
  // login vs lobby (SA-3). The seen-intro flag lives in SaveData.flags now.
  if (saveManager.getFlag(SEEN_INTRO_FLAG)) {
    void resolveEntry();
  } else {
    goIntro();
  }
}

/**
 * Map a virtual top-up code to an IAP tier (S2-6 dev entry). Replaces the real
 * platform purchase SDK until launch; the magic word "taowang" tops up the mid
 * tier, with -s / -l suffixes for the small / large tiers.
 */
function rechargeTier(code: string): 'small' | 'mid' | 'large' | null {
  switch (code.trim().toLowerCase()) {
    case 'taowang':   return 'mid';
    case 'taowang-s': return 'small';
    case 'taowang-l': return 'large';
    default:          return null;
  }
}

/** Map a server auth error code to a LoginScene message key (SA-3). */
function mapAuthError(e: unknown): TranslationKey {
  const code = e instanceof ApiError ? e.code : '';
  switch (code) {
    case 'LOGIN_ID_TAKEN':      return 'auth.err.taken';
    case 'INVALID_CREDENTIALS': return 'auth.err.invalid';
    case 'WEAK_PASSWORD':       return 'auth.err.weak';
    case 'BAD_REQUEST':         return 'auth.err.loginId';
    default:                    return 'auth.err.network';
  }
}
