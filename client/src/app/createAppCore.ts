// createAppCore — the render-free orchestration core of the client. Owns i18n
// init, SaveManager / ApiClient / ReplayStore, the NetSession wiring, and every
// navigation + business-logic decision (which port to call, in what order). It
// talks to the screen layer only through the `AppViews` interface, so the exact
// same code runs under PixiAppViews (real game) and HeadlessAppViews (full-link
// E2E). It uses only the render-free methods of IPlatform — never getCanvas /
// setupInput — and imports scene types with `import type` so PixiJS never leaks
// into this module's runtime graph.
//
// This is a behaviour-preserving extraction of the old startApp() closure; see
// app.ts for the thin PIXI shell that constructs PixiAppViews and calls start().

import type { IPlatform } from '../platform/IPlatform';
import type { AppViews, LobbyView, RoomView, FriendsView, ChatView, NetGameView } from './AppViews';
import { getLevel, CAMPAIGN_LEVEL_ORDER, createGameEngine, RecordingInputSource } from '../game';
import type { OwnerId, PlayerStats, MatchStartInfo, Replay } from '../game';
import { computeStars, remainingHpPct } from '../game/meta/campaignRewards';
import { initI18n, t, type TranslationKey } from '../i18n';
import { LocalSaveStore, SaveManager, ReplayStore } from '../game/meta';
import { ApiClient, ApiError, type AuthResult } from '../net/ApiClient';
import { serverReplayToReplay } from '../net/serverReplay';
import { getApiBaseUrl, getGatewayWsUrl } from '../net/config';
import { NetSession } from '../net/NetSession';
import { netLog } from '../net/log';
import { matchStateHash } from '../net/judgeRunner';
import { MatchMode } from '../net/proto/transport';
import { EQUIP_SLOT } from './equipSlot';
import type { ProfileData } from '../render/ProfilePopup';
import type { AuthOutcome } from '../scenes/LoginScene';
import type { RenameOutcome } from '../scenes/SettingsScene';
import type { EloResult } from '../scenes/ResultScene';
import * as analytics from '../analytics';
import { WorldApiClient } from '../net/WorldApiClient';
import { getWorldBaseUrl } from '../net/config';

const log = netLog('app');

/** flags key — set after the first-launch intro has been seen. */
const SEEN_INTRO_FLAG = 'seen_intro';
/** Persisted JWT for a real (non-anonymous) account, so logins survive restarts. */
const TOKEN_KEY = 'nw_token';
/** Persisted display name shown in the lobby profile chip / settings screen. */
const PLAYER_NAME_KEY = 'nw_player_name';
/** Persisted 9-digit public id (player-facing identifier; accountId stays internal). */
const PLAYER_PUBLIC_ID_KEY = 'nw_player_public_id';
/** Coin cost to change the display name. Mirrors server RENAME_COST; server authoritative. */
const RENAME_COST = 500;

export interface AppCore {
  /** First launch → intro; otherwise entry gating (login vs lobby). Call once. */
  start(): void;
  /** Called by the shell after a window resize (shell already re-rendered). */
  onResized(): void;
}

export function createAppCore(platform: IPlatform, views: AppViews): AppCore {
  // i18n must be ready before any scene builds its texts / playerName() runs.
  initI18n(platform.getLanguage(), platform.storage, platform.supportedLocales);

  // ── SaveManager: local-first save + optional cloud sync ─────────────────────
  const baseUrl = getApiBaseUrl(platform.storage);
  const api = baseUrl ? new ApiClient(baseUrl) : undefined;
  const replayStore = new ReplayStore(platform.storage);
  const saveManager = new SaveManager({
    store: new LocalSaveStore(platform.storage),
    api,
    getCredential: () => platform.getAuthCredential(),
    // L1 抽检（§8.6）：离线 flush 被抽中时据 replayId 取回本地录像补传复算。
    loadReplay: (id) => replayStore.load(id),
    onProfile: ({ displayName, publicId, gatewayUrl: gw }) => {
      applyGatewayUrl(gw);
      if (publicId) platform.storage.setItem(PLAYER_PUBLIC_ID_KEY, publicId);
      if (!displayName) return;
      if (platform.storage.getItem(PLAYER_NAME_KEY) === displayName) return;
      platform.storage.setItem(PLAYER_NAME_KEY, displayName);
      if (inLobby) goLobby();
    },
  });

  // Analytics SDK — fire and forget; config fetch failure degrades to disabled.
  void analytics.init(platform, api, baseUrl);

  // ── NetSession: online room + lockstep transport (three-channel, M20) ───────
  let gatewayUrl = getGatewayWsUrl(platform.storage);
  let netSession: NetSession | null = null;
  function getNetSession(): NetSession | null {
    if (netSession) return netSession;
    if (!api || !gatewayUrl) return null;
    netSession = new NetSession(platform, gatewayUrl, api, () => platform.getAuthCredential());
    netSession.handlers.onMatchStart = (info) => goGameNet(info);
    return netSession;
  }

  /** Adopt the server-provided gateway WS address (from auth/save). */
  function applyGatewayUrl(url?: string): void {
    if (!url || url === gatewayUrl) return;
    gatewayUrl = url;
    if (netSession) { netSession.close(); netSession = null; }
    if (inLobby) goLobby();
  }

  // ── Navigation state ────────────────────────────────────────────────────────
  let inLobby = false;
  let offlineMode = false;
  /**
   * Cached aggregate social unread (GET /social/badges). Kept across lobby
   * re-shows (e.g. window resize) so the red dot survives a rebuild without a
   * refetch; refreshed on lobby entry + nudged by live social pushes.
   */
  let socialBadgeTotal = 0;

  /** Re-fetch the authoritative social badge total and push it into the lobby. */
  async function refreshSocialBadge(view: LobbyView): Promise<void> {
    if (!api || offlineMode || !platform.storage.getItem(TOKEN_KEY)) return;
    try {
      const b = await api.getSocialBadges();
      socialBadgeTotal = b.total;
      view.applySocialBadge(b.total);
    } catch { /* best-effort red dot — leave the cached value in place */ }
  }

  function goIntro(): void {
    inLobby = false;
    analytics.track('screen_view', { scene: 'IntroScene' });
    views.showIntro({
      onFinish() {
        saveManager.setFlag(SEEN_INTRO_FLAG, true);
        void resolveEntry();
      },
    });
  }

  /** Display name for the profile chip: persisted name, else a generic guest label. */
  function playerName(): string {
    return platform.storage.getItem(PLAYER_NAME_KEY) || t('settings.guest');
  }

  function goLobby(opts?: { offline?: boolean; fromResize?: boolean }): void {
    if (opts?.offline !== undefined) offlineMode = opts.offline;
    inLobby = true;
    platform.onGameplayStop();
    if (!opts?.fromResize) analytics.track('screen_view', { scene: 'LobbyScene' });
    const pvp = saveManager.get().pvp;
    const loggedIn = !offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    const online = loggedIn && !!api && !!gatewayUrl;
    const lobby = views.showLobby({
      onStartGame(_opponentName: string) { goGame(); },
      onStartRanked() { goRoom({ autoRanked: true }); },
      online,
      onStartCampaign(_levelIndex: number) { goCampaignMap(); },
      onOpenRoom() { goRoom(); },
      onOpenSocial() { goFriends(); },
      onOpenShop() { goShop(); },
      onOpenCards() { goCollection(goLobby, 'cards'); },
      onOpenStats() { goStats(); },
      onOpenWorld() { goWorldEntry(); },
      onOpenProfile() { goSettings(); },
      playerName: playerName(),
      pvp: { rank: pvp.rank, elo: pvp.elo },
      offline: offlineMode,
      onLogin: () => goLogin(),
      onLogout: loggedIn ? () => doLogout() : undefined,
    });

    // Paint the cached social total immediately so the dot survives a resize
    // rebuild without flicker; then refresh from the server (skip on resize).
    lobby.applySocialBadge(socialBadgeTotal);
    if (online) {
      // Keep the gateway connected while idling in the lobby so presence + live
      // social pushes (request / chat / mail) update the red dot in real time.
      const onSocialPush = (): void => { void refreshSocialBadge(lobby); };
      const session = getNetSession();
      if (session) {
        session.handlers = {
          onMatchStart: (info) => goGameNet(info),
          onFriendRequest: onSocialPush,
          onFriendUpdate:  onSocialPush,
          onChatMessage:   onSocialPush,
          onMailNew:       onSocialPush,
        };
        session.connect();
      }
      if (!opts?.fromResize) void refreshSocialBadge(lobby);
    } else {
      socialBadgeTotal = 0;
    }
  }

  function goSettings(): void {
    inLobby = false;
    const pvp = saveManager.get().pvp;
    const loggedIn = !offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    const canRename = !offlineMode && !!api && loggedIn;
    views.showSettings({
      onBack() { goLobby(); },
      playerName: playerName(),
      ...(platform.storage.getItem(PLAYER_PUBLIC_ID_KEY)
        ? { publicId: platform.storage.getItem(PLAYER_PUBLIC_ID_KEY)! }
        : {}),
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
    });
  }

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

  function goLogin(): void {
    inLobby = false;
    analytics.track('screen_view', { scene: 'LoginScene' });
    views.showLogin({
      onPlayOffline() { goLobby({ offline: true }); },
      onLogin: (loginId, password) => doAuth(() => api!.login(loginId, password), loginId),
      onRegister: (loginId, password, displayName) =>
        doAuth(() => api!.register(loginId, password, displayName), displayName || loginId),
    });
  }

  async function doAuth(call: () => Promise<AuthResult>, name?: string): Promise<AuthOutcome> {
    if (!api) {
      console.error('[auth] no API base configured (__NW_API_BASE__ empty) — request not sent');
      return { ok: false, errorKey: 'auth.err.network', detail: 'API base not configured' };
    }
    try {
      const res = await call();
      platform.storage.setItem(TOKEN_KEY, res.token);
      applyGatewayUrl(res.gatewayUrl);
      const resolvedName = res.displayName || name;
      if (resolvedName) platform.storage.setItem(PLAYER_NAME_KEY, resolvedName);
      if (res.publicId) platform.storage.setItem(PLAYER_PUBLIC_ID_KEY, res.publicId);
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
      void saveManager.adoptSession(saveManager.get().accountId);
      goLobby({ offline: false });
      return;
    }
    goLogin();
  }

  function goRoom(opts?: { autoRanked?: boolean }): void {
    inLobby = false;
    analytics.track('screen_view', { scene: 'RoomScene', ranked: !!opts?.autoRanked });
    const session = getNetSession();
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
    const view: RoomView = views.showRoom({
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
      session.handlers = {
        onMatchStart: (info) => goGameNet(info),
        onRoomState: (s) => view.applyRoomState(s),
        onRoomError: (e) => view.applyRoomError(e),
        onPeerDc:    (p) => view.applyPeerDc(p),
        onNetState:  (s) => {
          view.applyNetState(s);
          if (autoRanked && s === 'open') queueRanked();
        },
      };
      session.connect();
      if (autoRanked && session.gateway.getState() === 'open') queueRanked();
    }
  }

  function goFriends(): void {
    // Social needs a server account; offline / no API → bounce to login.
    if (!api) { goLogin(); return; }
    analytics.track('screen_view', { scene: 'FriendsScene' });
    const client = api;
    inLobby = false;
    const session = getNetSession();
    // Restore the default match-start handler when leaving (mirrors goRoom).
    const restore = (): void => {
      if (session) session.handlers = { onMatchStart: (info) => goGameNet(info) };
    };
    const view: FriendsView = views.showFriends({
      onBack() { restore(); goLobby(); },
      onOpenRoom() { goRoom(); },
      loadFriends: () => client.getFriends(),
      loadRequests: () => client.getFriendRequests(),
      search: (publicId) => client.searchFriend(publicId),
      addFriend: async (publicId) => { await client.requestFriend(publicId); },
      respond: (requestId, accept) => client.respondFriend(requestId, accept),
      removeFriend: (publicId) => client.removeFriend(publicId),
      blockUser: (publicId) => client.blockUser(publicId),
      // chat (S6-2)
      loadConversations: () => client.getConversations(),
      openChat: (peerPublicId, peerName) => goChat(peerPublicId, peerName),
      // mail (S6-3)
      loadMail: () => client.getMail(),
      markMailRead: (mailId) => client.readMail(mailId),
      async claimMail(mailId) {
        const { save } = await client.claimMail(mailId);
        saveManager.adoptServer(save);
        return true;
      },
      deleteMail: (mailId) => client.deleteMail(mailId),
    });
    // Live social pushes (presence / request / friend add-remove / chat / mail)
    // arrive over the gateway control plane; forward them so the tabs stay fresh.
    if (session) {
      session.handlers = {
        onMatchStart: (info) => goGameNet(info),
        onFriendPresence: (p) => view.applyFriendPresence(p),
        onFriendRequest:  (r) => view.applyFriendRequest(r),
        onFriendUpdate:   (u) => view.applyFriendUpdate(u),
        onChatMessage:    (m) => view.applyChatMessage(m),
        onMailNew:        (m) => view.applyMailNew(m),
      };
      session.connect();
    }
  }

  function goChat(peerPublicId: string, peerName: string): void {
    if (!api) { goLogin(); return; }
    const client = api;
    inLobby = false;
    const session = getNetSession();
    const myPublicId = platform.storage.getItem(PLAYER_PUBLIC_ID_KEY) ?? '';
    const restore = (): void => {
      if (session) session.handlers = { onMatchStart: (info) => goGameNet(info) };
    };
    const view: ChatView = views.showChat({
      peerName,
      peerPublicId,
      myPublicId,
      onBack() { restore(); goFriends(); },
      async resolveConvId(pid) {
        const convs = await client.getConversations();
        return convs.find((c) => c.peer.publicId === pid)?.convId ?? null;
      },
      loadMessages: (convId, before) => client.getMessages(convId, before),
      send: (body) => client.sendChat(peerPublicId, body),
      markRead: (convId) => client.readChat(convId),
    });
    // Forward inbound chat pushes to the open window (others ignored here).
    if (session) {
      session.handlers = {
        onMatchStart: (info) => goGameNet(info),
        onChatMessage: (m) => view.applyIncoming(m),
      };
      session.connect();
    }
  }

  function goWorldEntry(): void {
    const worldBase = getWorldBaseUrl();
    if (!worldBase) { goLobby(); return; }
    const token = platform.storage.getItem(TOKEN_KEY);
    if (!token) { goLogin(); return; }
    const worldApi = new WorldApiClient(platform.storage);
    // Use a fixed world ID for now; in future this would come from the server
    const worldId = 'world:1:0';
    inLobby = false;
    goWorldMap(worldApi, worldId);
  }

  function goWorldMap(worldApi: WorldApiClient, worldId: string): void {
    views.showWorldMap({
      onBack() { goLobby(); },
      onOpenFamily() { goFamilyHub(worldApi, worldId); },
      onOpenAuction() { goAuctionHouse(worldApi, worldId); },
      worldApi,
      worldId,
      playerName: playerName(),
    });
  }

  function goFamilyHub(worldApi: WorldApiClient, worldId: string): void {
    const myAccountId = platform.storage.getItem('nw_account_id') ?? '';
    views.showFamily({
      onBack() { goWorldMap(worldApi, worldId); },
      worldApi,
      worldId,
      myAccountId,
    });
  }

  function goAuctionHouse(worldApi: WorldApiClient, worldId: string): void {
    views.showAuction({
      onBack() { goWorldMap(worldApi, worldId); },
      worldApi,
      worldId,
    });
  }

  function goShop(): void {
    if (!api) { goLobby(); return; }
    const client = api;
    inLobby = false;
    analytics.track('shop_open', {});
    views.showShop({
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
    });
  }

  function goGacha(): void {
    if (!api) { goLobby(); return; }
    const client = api;
    inLobby = false;
    views.showGacha({
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
    });
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
    platform.onGameplayStart();
    analytics.track('game_start', { mode: 'pvp_ai' });
    const gameStartTs = Date.now();
    views.showGame({
      onGameEnd(winner, stats, replay) {
        analytics.track('game_end', {
          mode: 'pvp_ai',
          result: winner === 0 ? 'win' : winner === 1 ? 'loss' : 'draw',
          duration_sec: Math.round((Date.now() - gameStartTs) / 1000),
        });
        goResult(winner, stats, 0, keepReplay(replay));
      },
      onExitToLobby() {
        analytics.track('game_end', { mode: 'pvp_ai', result: 'abandon', duration_ticks: 0 });
        goLobby();
      },
    }, { equippedSkin: saveManager.get().equipped[EQUIP_SLOT] ?? null });
  }

  function goCampaignMap(): void {
    inLobby = false;
    analytics.track('screen_view', { scene: 'CampaignMapScene' });
    views.showCampaignMap({
      onBack() { goLobby(); },
      onSelectLevel(levelId) { goLevelPrep(levelId); },
      onOpenCollection() { goCollection(goCampaignMap, 'skins'); },
      getStars: () => saveManager.get().progress.stars,
      getCleared: () => saveManager.get().progress.cleared,
      // PvE 服务器权威：通关/解锁须联网（§8 决策 4）。离线只能重刷已解锁关，新解锁锁住。
      isOnline: () => saveManager.online(),
      getPendingLevels: () => saveManager.getPendingClears().map((p) => p.levelId),
    });
  }

  function goLevelPrep(levelId: string): void {
    const level = getLevel(levelId);
    if (!level) { goCampaignMap(); return; }
    const levelNumber = CAMPAIGN_LEVEL_ORDER.indexOf(levelId) + 1 || 1;
    inLobby = false;
    analytics.track('level_attempt', {
      level_id: levelId,
      stars_before: saveManager.get().progress.stars[levelId] ?? 0,
    });
    views.showLevelPrep({
      onBack() { goCampaignMap(); },
      onStart() { analytics.track('screen_view', { scene: 'GameScene' }); goCampaign(levelId); },
      levelNumber,
      getMaterials: () => saveManager.get().materials,
      getUpgradeLevel: (id) => saveManager.get().pveUpgrades[id] ?? 0,
      // 升级是服务器权威扣费，仅在线可用（§8 决策 4）。
      isOnline: () => saveManager.online(),
      tryUpgrade: (id) => saveManager.upgrade(id),
      ...(level.briefKey ? { brief: t(level.briefKey) } : {}),
      ...(level.story?.introKey ? { intro: t(level.story.introKey) } : {}),
    });
  }

  function goCollection(back: () => void, initialTab: 'cards' | 'skins' = 'cards'): void {
    inLobby = false;
    views.showCollection({
      onBack: back,
      initialTab,
      getSkins: () => saveManager.get().inventory.skins,
      getEquipped: () => saveManager.get().equipped[EQUIP_SLOT] ?? null,
      equip: (skinId) => {
        saveManager.update((d) => {
          if (skinId === null) delete d.equipped[EQUIP_SLOT];
          else d.equipped[EQUIP_SLOT] = skinId;
        });
      },
    });
  }

  function goStats(): void {
    inLobby = false;
    const loggedIn = !offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    const client = api;
    views.showStats({
      onBack: () => goLobby(),
      // 仅登录在线时拉服务端对战历史 + 看回放；离线 / 未登录则不提供（页面显示离线提示）。
      ...(client && loggedIn
        ? {
            loadHistory: () => client.getMatchHistory(),
            onWatchReplay: (roomId: string) => {
              void client
                .getMatchReplay(roomId)
                .then((sr) => goReplay(serverReplayToReplay(sr), goStats))
                .catch(() => {
                  /* 录像缺失/解码失败：best-effort，留在 stats */
                });
            },
          }
        : {}),
      getStats: () => {
        const save = saveManager.get();
        const stars = Object.values(save.progress.stars).reduce((a, b) => a + b, 0);
        return {
          pvp: {
            rank: save.pvp.rank,
            elo: save.pvp.elo,
            wins: save.pvp.wins,
            losses: save.pvp.losses,
            streak: save.pvp.streak,
          },
          cleared: save.progress.cleared.length,
          totalLevels: CAMPAIGN_LEVEL_ORDER.length,
          stars,
          skinsOwned: save.inventory.skins.length,
          materials: save.materials,
        };
      },
    });
  }

  function goCampaign(levelId: string | undefined): void {
    const level = levelId ? getLevel(levelId) : null;
    if (!level || !levelId) { goLobby(); return; }
    inLobby = false;
    platform.onGameplayStart();
    analytics.track('game_start', { mode: 'campaign', level_id: levelId });
    const campaignStartTs = Date.now();
    views.showGame({
      onGameEnd(winner, stats, replay) {
        // 先落盘录像（一次），既供结算页回放、也供 L1 抽检（§8.6）补传复算。
        const kept = keepReplay(replay);
        const durationSec = Math.round((Date.now() - campaignStartTs) / 1000);
        if (winner === 0) {
          const pct = remainingHpPct(stats[0].damageTakenByBase);
          const stars = computeStars(level.rewards?.starThresholds, pct);
          analytics.track('level_complete', {
            level_id: levelId,
            stars,
            duration_sec: durationSec,
          });
          // 服务器权威结算（§8）：在线 → POST /pve/clear（被抽中则用 kept 录像走 /pve/verify 复算）；
          // 离线 → 入队待结算（fire-and-forget，回到 CampaignMap 时重读 save / pending 反映状态）。
          if (stars > 0) void saveManager.recordClear(levelId, stars, kept);
        } else {
          analytics.track('game_end', {
            mode: 'campaign',
            result: 'loss',
            level_id: levelId,
            duration_sec: durationSec,
          });
        }
        const outroText = (winner === 0 && level.story?.outroKey) ? t(level.story.outroKey) : undefined;
        goResult(winner, stats, 0, kept, undefined, undefined, outroText);
      },
      onExitToLobby() {
        analytics.track('level_abandon', { level_id: levelId, phase: 'in_game' });
        goLobby();
      },
    }, {
      level,
      pveUpgrades: saveManager.get().pveUpgrades,
      equippedSkin: saveManager.get().equipped[EQUIP_SLOT] ?? null,
    });
  }

  function goReplay(replay: Replay, onExit: () => void = goLobby): void {
    inLobby = false;
    platform.onGameplayStart();
    views.showReplay(replay, {
      onExit() { onExit(); },
    });
  }

  function goGameNet(info: MatchStartInfo): void {
    const session = netSession;
    if (!session) { goLobby(); return; }
    inLobby = false;
    platform.onGameplayStart();
    const isRankedMode = info.mode === MatchMode.RANKED;
    analytics.track('game_start', { mode: isRankedMode ? 'pvp_ranked' : 'pvp_friendly' });
    const netGameStartTs = Date.now();

    const localOwner = info.localSide as OwnerId;

    const localPvp = saveManager.get().pvp;
    const oppProfile: ProfileData = { name: info.opponentName, publicId: info.opponentPublicId };
    const localProfile: ProfileData = {
      name: playerName(),
      publicId: platform.storage.getItem(PLAYER_PUBLIC_ID_KEY) ?? '',
      rankKey: localPvp.rank,
      elo: localPvp.elo,
      isSelf: true,
    };
    const profiles = { opponent: oppProfile, local: localProfile };

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

    const isRanked = isRankedMode;
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
      if (isRanked) void saveManager.refresh();
      void goResult(winner, stats, localOwner, keepReplay(replay), elo, profiles);
    };

    const view: NetGameView = views.showGameNet(localOwner, {
      onGameEnd(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]) {
        session.reportResult(matchStateHash(winner, stats), winner ?? 0);
        const replay = buildNetReplay(winner);
        const result = winner === null ? 'draw' : winner === localOwner ? 'win' : 'loss';
        analytics.track('game_end', {
          mode: isRanked ? 'pvp_ranked' : 'pvp_friendly',
          result,
          duration_sec: Math.round((Date.now() - netGameStartTs) / 1000),
        });
        if (isRanked) {
          pending = { winner, stats, replay };
          eloWaitTimer = setTimeout(() => finishNet(winner, stats, lastElo, replay), 6000);
        } else {
          finishNet(winner, stats, undefined, replay);
        }
      },
      onNetMatchOver(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]) {
        finishNet(winner, stats, lastElo, buildNetReplay(winner));
      },
      onExitToLobby() {
        analytics.track('game_end', { mode: isRanked ? 'pvp_ranked' : 'pvp_friendly', result: 'abandon', duration_sec: Math.round((Date.now() - netGameStartTs) / 1000) });
        session.close(); goLobby();
      },
    }, { engine, net: true, profiles });

    session.handlers = {
      onMatchStart: (i) => goGameNet(i),
      onNetState:   (s) => view.applyNetState(s),
      onPeerDc:     (p) => view.applyPeerDc(p),
      onMatchOver:  (m) => {
        lastElo = m.elo ? { delta: m.elo.delta, after: m.elo.after, rankAfter: m.elo.rankAfter } : undefined;
        view.applyMatchOver(m);
        if (pending) finishNet(pending.winner, pending.stats, lastElo, pending.replay);
      },
    };
  }

  async function goResult(
    winner: OwnerId | null,
    stats: [PlayerStats, PlayerStats],
    localOwner: OwnerId = 0,
    replay?: Replay,
    elo?: EloResult,
    profiles?: { opponent?: ProfileData; local?: ProfileData },
    outroText?: string,
  ): Promise<void> {
    inLobby = false;
    platform.onGameplayStop();
    await platform.showMidgameAd();
    views.showResult({
      winner,
      stats,
      localOwner,
      ...(elo ? { elo } : {}),
      ...(profiles ? { profiles } : {}),
      ...(outroText ? { outroText } : {}),
      cb: {
        onPlayAgain() { goLobby(); },
        ...(replay ? { onWatchReplay: () => goReplay(replay) } : {}),
      },
    });
  }

  function start(): void {
    if (saveManager.getFlag(SEEN_INTRO_FLAG)) {
      void resolveEntry();
    } else {
      goIntro();
    }
  }

  function onResized(): void {
    if (inLobby) goLobby({ fromResize: true });
  }

  return { start, onResized };
}

/** Map a virtual top-up code to an IAP tier (S2-6 dev entry). */
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
