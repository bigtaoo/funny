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
import { SettingsScene, type RenameOutcome } from './scenes/SettingsScene';
import { OwnerId, PlayerStats } from './game/types';
import { getLevel, CAMPAIGN_LEVEL_ORDER, createGameEngine, ownerToSide, RecordingInputSource } from './game';
import type { MatchStartInfo, Replay } from './game';
import { ScalingManager, createLayout } from './layout/ScalingManager';
import { InputManager } from './inputSystem/InputManager';
import type { ILayout } from './layout/ILayout';
import { initI18n, t, type TranslationKey } from './i18n';
import { LocalSaveStore, SaveManager, ReplayStore } from './game/meta';
import { ApiClient, ApiError, type AuthResult } from './net/ApiClient';
import { getApiBaseUrl, getGatewayWsUrl } from './net/config';
import { NetSession } from './net/NetSession';
import { netLog, installGlobalErrorHandlers } from './net/log';
import { matchStateHash } from './net/judgeRunner';

const log = netLog('app');
import { MatchMode } from './net/proto/transport';
import { setBakeRenderer } from './render/bake';

/** flags key — set after the first-launch intro has been seen (was the standalone nw_seen_intro key). */
const SEEN_INTRO_FLAG = 'seen_intro';

/** Persisted JWT for a real (non-anonymous) account, so logins survive restarts (SA-3 §5). */
const TOKEN_KEY = 'nw_token';

/** Persisted display name shown in the lobby profile chip / settings screen. */
const PLAYER_NAME_KEY = 'nw_player_name';

/** Persisted 9-digit public id (player-facing identifier; accountId stays server-internal). */
const PLAYER_PUBLIC_ID_KEY = 'nw_player_public_id';

/** Coin cost to change the display name. Mirrors server RENAME_COST (@nw/shared); server is authoritative. */
const RENAME_COST = 500;

export async function startApp(platform: IPlatform): Promise<void> {
  // Surface every uncaught error / rejection to the console (was silent before).
  installGlobalErrorHandlers();

  // i18n must be ready before any scene builds its texts
  initI18n(platform.getLanguage(), platform.storage, platform.supportedLocales);

  // ── SaveManager (S0): local-first save + optional cloud sync ────────────────
  const baseUrl = getApiBaseUrl(platform.storage);
  const api = baseUrl ? new ApiClient(baseUrl) : undefined;
  const saveManager = new SaveManager({
    store: new LocalSaveStore(platform.storage),
    api,
    getCredential: () => platform.getAuthCredential(),
    // Cloud-authoritative display name (returned by GET /save). On token re-entry the
    // pull happens after the lobby is already shown, so persist the name and, if it
    // actually changed, rebuild the lobby so the profile chip picks it up.
    onProfile: ({ displayName, publicId, gatewayUrl: gw }) => {
      applyGatewayUrl(gw); // server-provided gateway address (rebuilds lobby if it changed)
      if (publicId) platform.storage.setItem(PLAYER_PUBLIC_ID_KEY, publicId);
      if (!displayName) return;
      if (platform.storage.getItem(PLAYER_NAME_KEY) === displayName) return;
      platform.storage.setItem(PLAYER_NAME_KEY, displayName);
      if (inLobby) goLobby();
    },
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
  // Client only hardcodes the meta URL. The gateway address is delivered by the server
  // in auth/save responses (applyGatewayUrl below); the game address arrives per-match
  // in match_found. getGatewayWsUrl is just a build-time fallback (prod same-origin /
  // dev inject) used until the server tells us otherwise.
  let gatewayUrl = getGatewayWsUrl(platform.storage);
  let netSession: NetSession | null = null;
  function getNetSession(): NetSession | null {
    if (netSession) return netSession;
    if (!api || !gatewayUrl) return null;
    netSession = new NetSession(platform, gatewayUrl, api, () => platform.getAuthCredential());
    netSession.handlers.onMatchStart = (info) => goGameNet(info);
    return netSession;
  }

  /**
   * Adopt the server-provided gateway WS address (from auth/save). Overrides the
   * build-time fallback; a session built against the stale address is dropped so the
   * next getNetSession() rebuilds. Refreshes the lobby so its online state re-evaluates.
   */
  function applyGatewayUrl(url?: string): void {
    if (!url || url === gatewayUrl) return;
    gatewayUrl = url;
    if (netSession) { netSession.close(); netSession = null; }
    if (inLobby) goLobby();
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

  /** Display name for the profile chip: persisted name, else a generic guest label. */
  function playerName(): string {
    return platform.storage.getItem(PLAYER_NAME_KEY) || t('settings.guest');
  }

  function goLobby(opts?: { offline?: boolean }): void {
    if (opts?.offline !== undefined) offlineMode = opts.offline;
    inLobby = true;
    platform.onGameplayStop();
    const pvp = saveManager.get().pvp;
    const loggedIn = !offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    // Online = logged in + a server is reachable → the match button does real PvP
    // ranked matchmaking; otherwise it falls back to the local AI quick-match.
    const online = loggedIn && !!api && !!gatewayUrl;
    manager.goto(new LobbyScene(layout, input, {
      onStartGame(_opponentName: string) { goGame(); },
      onStartRanked() { goRoom({ autoRanked: true }); },
      online,
      onStartCampaign(levelIndex: number) { goCampaign(CAMPAIGN_LEVEL_ORDER[levelIndex]); },
      onOpenRoom() { goRoom(); },
      onOpenShop() { goShop(); },
      onOpenProfile() { goSettings(); },
      playerName: playerName(),
      pvp: { rank: pvp.rank, elo: pvp.elo },
      offline: offlineMode,
      onLogin: () => goLogin(),
      onLogout: loggedIn ? () => doLogout() : undefined,
    }));
    window.addEventListener('resize', onResize);
  }

  // Personal profile / settings — language switch + account (login/logout) + rename.
  function goSettings(): void {
    inLobby = false;
    window.removeEventListener('resize', onResize);
    const pvp = saveManager.get().pvp;
    const loggedIn = !offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    // Rename spends server-authoritative coins → only when online (api + token).
    const canRename = !offlineMode && !!api && loggedIn;
    manager.goto(new SettingsScene(layout, input, {
      onBack() { goLobby(); },
      playerName: playerName(),
      pvp: { rank: pvp.rank, elo: pvp.elo },
      offline: offlineMode,
      onLogin: () => goLogin(),
      onLogout: loggedIn ? () => doLogout() : undefined,
      ...(canRename
        ? {
            renameCost: RENAME_COST,
            getCoins: () => saveManager.get().wallet.coins,
            onRename: doRename,
          }
        : {}),
    }));
  }

  /** Spend coins to change the display name; persists locally + adopts the pushed save. */
  async function doRename(name: string): Promise<RenameOutcome> {
    if (!api) return { ok: false, key: 'settings.renameFail' };
    try {
      const { save, displayName } = await api.rename(name);
      saveManager.adoptServer(save);
      platform.storage.setItem(PLAYER_NAME_KEY, displayName);
      return { ok: true, name: displayName };
    } catch (e) {
      console.error('[rename] failed', e);
      return {
        ok: false,
        key: e instanceof ApiError && e.code === 'INSUFFICIENT_FUNDS'
          ? 'settings.renameInsufficient' : 'settings.renameFail',
      };
    }
  }

  // SA-3: login screen + entry gating + persistent token.
  function goLogin(): void {
    inLobby = false;
    window.removeEventListener('resize', onResize);
    manager.goto(new LoginScene(layout, input, {
      onPlayOffline() { goLobby({ offline: true }); },
      onLogin: (loginId, password) => doAuth(() => api!.login(loginId, password), loginId),
      onRegister: (loginId, password, displayName) =>
        doAuth(() => api!.register(loginId, password, displayName), displayName || loginId),
    }));
  }

  /** Run a login/register call; on success persist token, reconcile, enter lobby. */
  async function doAuth(call: () => Promise<AuthResult>, name?: string): Promise<AuthOutcome> {
    if (!api) {
      console.error('[auth] no API base configured (__NW_API_BASE__ empty) — request not sent');
      return { ok: false, errorKey: 'auth.err.network', detail: 'API base not configured' };
    }
    try {
      const res = await call();
      platform.storage.setItem(TOKEN_KEY, res.token);
      applyGatewayUrl(res.gatewayUrl); // server-provided gateway address (before goLobby reads `online`)
      // Prefer the server's stored display name (so login restores the name set at
      // registration); fall back to the locally supplied name (loginId / register input).
      const resolvedName = res.displayName || name;
      if (resolvedName) platform.storage.setItem(PLAYER_NAME_KEY, resolvedName);
      if (res.publicId) platform.storage.setItem(PLAYER_PUBLIC_ID_KEY, res.publicId);
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
    platform.storage.removeItem(PLAYER_NAME_KEY);
    platform.storage.removeItem(PLAYER_PUBLIC_ID_KEY);
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

  function goRoom(opts?: { autoRanked?: boolean }): void {
    inLobby = false;
    window.removeEventListener('resize', onResize);
    const session = getNetSession();
    // autoRanked: the lobby match button jumped straight here for real PvP — start
    // the scene in its searching view and fire the ranked queue once the gateway
    // is open (the createRanked send is dropped while the socket is still opening).
    const autoRanked = !!opts?.autoRanked && session !== null;
    if (opts?.autoRanked && session === null) {
      log.warn('autoRanked requested but no NetSession (offline / no gateway url)', {
        hasApi: !!api,
        gatewayUrl,
      });
    }
    let rankedQueued = false;
    const queueRanked = (): void => {
      if (rankedQueued) return;
      rankedQueued = true;
      log.info('entering ranked queue (createRanked)');
      session?.createRanked();
    };
    const scene = new RoomScene(layout, input, {
      available: session !== null,
      autoRanked,
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
      cancelQueue() { rankedQueued = false; session?.cancelQueue(); },
    });

    if (session) {
      // Route server room events to the live scene; keep onMatchStart on app.
      session.handlers = {
        onMatchStart: (info) => goGameNet(info),
        onRoomState: (s) => scene.applyRoomState(s),
        onRoomError: (e) => scene.applyRoomError(e),
        onPeerDc:    (p) => scene.applyPeerDc(p),
        onNetState:  (s) => {
          scene.applyNetState(s);
          if (autoRanked && s === 'open') queueRanked();
        },
      };
      session.connect();
      // Returning visitor: the gateway may already be open (no fresh 'open' event),
      // so kick the queue immediately in that case.
      if (autoRanked && session.gateway.getState() === 'open') queueRanked();
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

    // Record the confirmed lockstep stream locally so net matches also offer
    // "watch replay" (S1-RP). The server-confirmed stream already carries BOTH
    // sides' commands, so the recording reconstructs the full match.
    const recorder = new RecordingInputSource(session.input);
    const engine = createGameEngine(
      { seed: info.seed, players: [{ id: 0 }, { id: 1 }], mode: 'netplay' },
      recorder,
    );
    const buildNetReplay = (winner: OwnerId | null): Replay =>
      recorder.snapshot({
        seed: info.seed,
        mode: 'netplay',
        meta: { recordedAt: Date.now(), winner: winner ?? -1 },
      });

    // Ranked needs the server-authoritative ELO (arrives in match_over) before
    // showing the result. Friendly shows the result immediately on local end.
    const isRanked = info.mode === MatchMode.RANKED;
    let netResultShown = false;
    let lastElo: EloResult | undefined;
    let pending: { winner: OwnerId | null; stats: [PlayerStats, PlayerStats]; replay?: Replay } | null = null;
    let eloWaitTimer: ReturnType<typeof setTimeout> | null = null;
    const finishNet = (
      winner: OwnerId | null,
      stats: [PlayerStats, PlayerStats],
      elo?: EloResult,
      replay?: Replay,
    ): void => {
      if (netResultShown) return;
      netResultShown = true;
      if (eloWaitTimer) { clearTimeout(eloWaitTimer); eloWaitTimer = null; }
      // ranked 局末 gameserver 已写 saves.pvp（elo/rank/streak）→ 拉一次刷新本地，
      // 让大厅段位徽章即时反映新分（reconcile 取云端权威段）。
      if (isRanked) void saveManager.refresh();
      void goResult(winner, stats, localOwner, keepReplay(replay), elo);
    };

    const scene = new GameScene(netLayout, input, {
      onGameEnd(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]) {
        // S1-5: report end-state hash + claimed winner (ranked needs the winner;
        // server settles ELO only when both clients agree on hash + winner).
        session.reportResult(matchStateHash(winner, stats), winner ?? 0);
        const replay = buildNetReplay(winner);
        if (isRanked) {
          // Hold the result until the server's match_over (ELO) arrives; if the
          // server is silent, fall back after 6s and show without ELO.
          pending = { winner, stats, replay };
          eloWaitTimer = setTimeout(() => finishNet(winner, stats, lastElo, replay), 6000);
        } else {
          finishNet(winner, stats, undefined, replay);
        }
      },
      // Server-driven end (opponent timeout / desync) — no hash to report.
      onNetMatchOver(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]) {
        finishNet(winner, stats, lastElo, buildNetReplay(winner));
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
        if (pending) finishNet(pending.winner, pending.stats, lastElo, pending.replay);
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
