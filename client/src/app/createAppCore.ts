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
import { getLevel, CAMPAIGN_LEVEL_ORDER, createGameEngine, RecordingInputSource, ENGINE_VERSION, achievementStatDelta } from '../game';
import { TUTORIAL_LEVEL_ID } from '@nw/engine';
import { isFirstChapterCleared } from '../game/campaign/progress';
import type { OwnerId, PlayerStats, MatchStartInfo, Replay, LevelDefinition } from '../game';
import { computeStars, remainingHpPct } from '../game/meta/campaignRewards';
import { initI18n, t, type TranslationKey } from '../i18n';
import { LocalSaveStore, SaveManager, ReplayStore } from '../game/meta';
import { hasClaimable, reachedTierKeys } from '../game/meta/achievements';
import { ApiClient, ApiError, type AuthResult } from '../net/ApiClient';
import { serverReplayToReplay } from '../net/serverReplay';
import { stateRecorder } from '../game/replay/StateRecorder';
import { decodeStateReplay, type EncodedStateReplay } from '../game/replay/StateReplay';
import { getApiBaseUrl, getGatewayWsUrl } from '../net/config';
import { NetSession } from '../net/NetSession';
import { FeatureFlags } from '../net/featureFlags';
import { netLog, showToastMessage } from '../net/log';
import { matchStateHash } from '../net/judgeRunner';
import { MatchMode } from '../net/proto/transport';
import { EQUIP_SLOT } from './equipSlot';
import { genUuid } from '../platform/uuid';
import type { EquipSlot } from '../game/meta/SaveData';
import { defaultPvpDeck, validatePvpDeckClient } from '../game/meta/pvpLoadout';
import type { ProfileData } from '../render/ProfilePopup';
import type { AuthOutcome } from '../scenes/LoginScene';
import type { RenameOutcome } from '../scenes/SettingsScene';
import type { EloResult } from '../scenes/ResultScene';
import * as analytics from '../analytics';
import { WorldApiClient } from '../net/WorldApiClient';
import { getWorldBaseUrl } from '../net/config';

const log = netLog('app');

/** Platform name (the TARGET global injected at build time), evaluated at bootstrap. Mirrors analytics.getPlatformName. */
function clientPlatformName(): 'web' | 'wechat' | 'crazygames' {
  const t = (globalThis as { TARGET?: string }).TARGET ?? '';
  if (t === 'wechat') return 'wechat';
  if (t === 'crazygames') return 'crazygames';
  return 'web';
}

/** flags key — set after the first-launch intro has been seen. */
const SEEN_INTRO_FLAG = 'seen_intro';
/** Set after the tutorial is completed or skipped; prevents auto-entry afterwards. Clearing it via "replay tutorial" in settings allows re-entry (ONBOARDING_DESIGN §3.4). */
const TUTORIAL_DONE_FLAG = 'tutorial_done';
/** flags key — set after the player accepts the GDPR / privacy consent (C5-c, L1-1). Mirrors server `flags.gdprConsent`. */
const GDPR_CONSENT_FLAG = 'gdprConsent';
/** Last seen ladder season number — used to detect season transitions and show the settlement popup (SE-6). */
const LAST_SEEN_SEASON_KEY = 'nw_last_seen_season';
/** Persisted JWT for a real (non-anonymous) account, so logins survive restarts. */
const TOKEN_KEY = 'nw_token';
/** Persisted display name shown in the lobby profile chip / settings screen. */
const PLAYER_NAME_KEY = 'nw_player_name';
/** Persisted 9-digit public id (player-facing identifier; accountId stays internal). */
const PLAYER_PUBLIC_ID_KEY = 'nw_player_public_id';
/** Persisted avatar token ('0'-'7'); absent = letter-initial fallback. */
const PLAYER_AVATAR_KEY = 'nw_player_avatar';
/** Coin cost to change the display name. Mirrors server RENAME_COST; server authoritative. */
const RENAME_COST = 500;
/**
 * Current SLG season number (G6/§20): worldsvc routes by `s{season}-{shard}` multi-shard scheme;
 * the client calls resolveSeason with this value before entering the map to obtain the real worldId.
 * Temporarily a client-side constant; will be provided by metaserver once S11 ladder-season metadata
 * is delivered (§20.8).
 */
const CURRENT_SEASON = 1;

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
    // L1 spot-check (§8.6): when a queued offline flush is selected for verification, fetch the
    // local replay by replayId and submit it for re-evaluation.
    loadReplay: (id) => replayStore.load(id),
    // Cloud save background sync persistently failing → show a one-time global fallback toast
    // (progress may not have reached the cloud).
    onSyncError: () => showToastMessage(t('common.syncFailed')),
    onProfile: ({ displayName, publicId, gatewayUrl: gw }) => {
      applyGatewayUrl(gw);
      if (publicId) {
        platform.storage.setItem(PLAYER_PUBLIC_ID_KEY, publicId);
        void featureFlags?.refresh(); // publicId received from save response → re-fetch bootstrap so targeted log capture takes effect immediately
      }
      if (!displayName) return;
      if (platform.storage.getItem(PLAYER_NAME_KEY) === displayName) return;
      platform.storage.setItem(PLAYER_NAME_KEY, displayName);
      if (inLobby) goLobby();
    },
  });

  // Analytics SDK — fire and forget; config fetch failure degrades to disabled.
  // GDPR gate (C5-c, L1-1): seed consent from the persisted flag BEFORE init so a
  // returning consented user's session_start fires, while a not-yet-consented user
  // emits nothing until they accept the dialog (setConsent in gateConsent).
  analytics.setConsent(saveManager.getFlag(GDPR_CONSENT_FLAG) === true);
  void analytics.init(platform, api, baseUrl);

  // ── FeatureFlags: public bootstrap polling + targeted client-log capture (FEATURE_FLAGS_DESIGN §9) ─────
  // Polling starts immediately on launch; when a client_log_* targeting rule matches, the ring-buffer
  // log is batch-uploaded to Loki. Requires an API base URL to be meaningful.
  const featureFlags = api
    ? new FeatureFlags({
        api,
        platform: clientPlatformName(),
        getPublicId: () => platform.storage.getItem(PLAYER_PUBLIC_ID_KEY),
      })
    : null;
  featureFlags?.start();

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
  /** One-shot: whether this session has already handled the "first lobby entry → tutorial" branch (ONBOARDING §2 step ⑤). */
  let firstLobbyHandled = false;
  /**
   * Cached aggregate social unread (GET /social/badges). Kept across lobby
   * re-shows (e.g. window resize) so the red dot survives a rebuild without a
   * refetch; refreshed on lobby entry + nudged by live social pushes.
   */
  let socialBadgeTotal = 0;
  /** Cached achievement-claimable flag, kept across lobby re-shows (mirrors socialBadgeTotal). */
  let achievementClaimable = false;
  /**
   * Baseline set of reached achievement tiers (`achId#tier`) from the last refresh (S9-5b).
   * `null` until the first post-login fetch — the first fetch only seeds the baseline (no toast
   * for already-unlocked tiers); subsequent refreshes (e.g. on returning to the lobby after a
   * PvE/PvP battle) diff against it and aggregate any new unlocks into a single toast (§7).
   */
  let achievementReached: Set<string> | null = null;

  /** Re-fetch the authoritative social badge total and push it into the lobby. */
  async function refreshSocialBadge(view: LobbyView): Promise<void> {
    if (!api || offlineMode || !platform.storage.getItem(TOKEN_KEY)) return;
    try {
      const b = await api.getSocialBadges();
      socialBadgeTotal = b.total;
      view.applySocialBadge(b.total);
    } catch { /* best-effort red dot — leave the cached value in place */ }
  }

  /** Re-fetch achievements and push the "any tier claimable" dot into the lobby (best-effort). */
  async function refreshAchievementBadge(view: LobbyView): Promise<void> {
    if (!api || offlineMode || !platform.storage.getItem(TOKEN_KEY)) return;
    try {
      const d = await api.getAchievements();
      achievementClaimable = hasClaimable(d.defs, d.stats, d.achievements);
      view.applyAchievementBadge(achievementClaimable);

      // S9-5b: diff reached tiers vs the baseline → one aggregated "unlocked" toast (§7).
      const reached = reachedTierKeys(d.defs, d.stats);
      if (achievementReached !== null) {
        const freshIds = new Set<string>();
        reached.forEach((k) => {
          if (!achievementReached!.has(k)) freshIds.add(k.slice(0, k.lastIndexOf('#')));
        });
        if (freshIds.size > 0) {
          const msg = freshIds.size === 1
            ? t('achievement.unlockToast', {
                name: t(('achievement.' + [...freshIds][0] + '.name') as TranslationKey),
              })
            : t('achievement.unlockToastMulti', { n: freshIds.size });
          view.showAchievementToast(msg);
          analytics.track('achievement_unlock_toast', { count: freshIds.size });
        }
      }
      achievementReached = reached;
    } catch { /* best-effort red dot — leave the cached value in place */ }
  }

  /**
   * GDPR consent gate (C5-c, L1-1). Runs `next()` immediately if consent was already
   * given (local flag, mirrors server `flags.gdprConsent`); otherwise shows the blocking
   * consent dialog and only proceeds once accepted. Anonymous / offline users see it too —
   * acceptance lands the local flag (synced to the server later via SaveManager push), and
   * the explicit recordGdprConsent fires immediately when a token is already present.
   */
  function gateConsent(next: () => void): void {
    if (saveManager.getFlag(GDPR_CONSENT_FLAG) === true) { next(); return; }
    views.showConsent({
      onAccept() {
        saveManager.setFlag(GDPR_CONSENT_FLAG, true);
        analytics.setConsent(true);
        analytics.track('gdpr_consent', { granted: true });
        const token = platform.storage.getItem(TOKEN_KEY);
        if (api && token) { api.setToken(token); void api.recordGdprConsent(true).catch(() => { /* best-effort; flag still syncs via SaveManager */ }); }
        next();
      },
    });
  }

  /** Re-fetch retention claimable state and push the daily red dot into the lobby (B5, best-effort). */
  async function refreshRetentionBadge(view: LobbyView): Promise<void> {
    if (!api || offlineMode || !platform.storage.getItem(TOKEN_KEY)) { view.applyRetentionBadge(false); return; }
    try {
      const r = await api.getRetention();
      view.applyRetentionBadge(r.claimable.checkin || r.claimable.daily);
    } catch { /* leave the dot off on failure */ }
  }

  /** Probe for an active event window so the events entry only appears when there's something to show (B6, best-effort). */
  async function refreshEventsAvailable(view: LobbyView): Promise<void> {
    if (!api || offlineMode || !platform.storage.getItem(TOKEN_KEY)) { view.applyEventsAvailable(false); return; }
    try {
      const events = await api.getEvents();
      view.applyEventsAvailable(events.length > 0);
    } catch { /* leave the entry hidden on failure */ }
  }

  function goIntro(): void {
    inLobby = false;
    analytics.track('screen_view', { scene: 'IntroScene' });
    views.showIntro({
      onFinish(skipped) {
        if (skipped) analytics.track('tutorial_skip', { step: 'intro' });
        saveManager.setFlag(SEEN_INTRO_FLAG, true);
        gateConsent(() => void resolveEntry());
      },
    });
  }

  /** Display name for the profile chip: persisted name, else a generic guest label. */
  function playerName(): string {
    return platform.storage.getItem(PLAYER_NAME_KEY) || t('settings.guest');
  }

  /** Selected avatar token, or undefined for letter-initial fallback. */
  function avatarId(): string | undefined {
    return platform.storage.getItem(PLAYER_AVATAR_KEY) ?? undefined;
  }

  function goLobby(opts?: { offline?: boolean; fromResize?: boolean }): void {
    // FTUE step ⑤: on the first lobby entry of this session, redirect to the dedicated tutorial
    // level if it has not been completed (ONBOARDING_DESIGN §2).
    // One-shot gate — subsequent returns to the lobby from child scenes do not re-trigger; resize redraws skip it too.
    if (!firstLobbyHandled && !opts?.fromResize) {
      firstLobbyHandled = true;
      if (!saveManager.getFlag(TUTORIAL_DONE_FLAG)) {
        if (opts?.offline !== undefined) offlineMode = opts.offline;
        goTutorial();
        return;
      }
    }
    if (opts?.offline !== undefined) offlineMode = opts.offline;
    inLobby = true;
    platform.onGameplayStop();
    if (!opts?.fromResize) analytics.track('screen_view', { scene: 'LobbyScene' });
    const pvp = saveManager.get().pvp;
    const loggedIn = !offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    const online = loggedIn && !!api && !!gatewayUrl;
    // First-time feature guide (ONBOARDING_DESIGN §4.1): if a feature's guide has not been seen,
    // show a dismissible guide card in the lobby before navigating; if already seen, navigate directly.
    // Covers all major lobby-reachable features (auction is inside the world map; each page's "?" button
    // re-shows the same guide using guide.* i18n + showFeatureGuide).
    function withGuide(featureId: string, titleKey: TranslationKey, bodyKey: TranslationKey, nav: () => void): void {
      if (saveManager.featSeen(featureId)) { nav(); return; }
      saveManager.markFeatSeen(featureId);
      lobby.showFeatureGuide(titleKey, bodyKey, nav);
    }
    const lobby = views.showLobby({
      onStartGame(_opponentName: string) { withGuide('match', 'guide.match.title', 'guide.match.body', () => goGame()); },
      onStartRanked() { goDeckBuilder(() => goRoom({ autoRanked: true })); },
      online,
      onOpenCampaign() { goCampaignMap(); },
      onOpenRoom() { goRoom(); },
      onOpenSocial() { withGuide('social', 'guide.social.title', 'guide.social.body', () => goFriends()); },
      ...(online ? { onOpenMail: () => goMail() } : {}),
      onOpenShop() { withGuide('shop', 'guide.shop.title', 'guide.shop.body', () => goGacha({})); },
      onOpenCards() { withGuide('cards', 'guide.cards.title', 'guide.cards.body', () => goCollection(goLobby, 'cards')); },
      onOpenStats() { goStats(); },
      ...(online ? { onOpenAchievements: () => goAchievements() } : {}),
      ...(online ? { onOpenDaily: () => withGuide('daily', 'guide.daily.title', 'guide.daily.body', () => goDaily()), onOpenEvents: () => goEvents() } : {}),
      onOpenWorld() { withGuide('world', 'guide.world.title', 'guide.world.body', () => goWorldEntry()); },
      // SLG soft gate (ONBOARDING_DESIGN §4): grayed out with a tooltip bubble until the first chapter is cleared — the only feature gate.
      worldLocked: !isFirstChapterCleared(new Set(saveManager.get().progress.cleared)),
      onOpenProfile() { goSettings(); },
      playerName: playerName(),
      avatarId: avatarId(),
      pvp: { rank: pvp.rank, elo: pvp.elo },
      coins: saveManager.get().wallet.coins,
      offline: offlineMode,
      onLogin: () => goLogin(),
      onLogout: loggedIn ? () => doLogout() : undefined,
    });

    // Season settlement popup (SE-6): detect first lobby entry after a season transition.
    // Store and compare pvp.seasonNo in localStorage so it survives restarts.
    if (!opts?.fromResize && (pvp.seasonNo ?? 1) > 0) {
      const lastSeen = parseInt(platform.storage.getItem(LAST_SEEN_SEASON_KEY) ?? '0', 10);
      const currentSeason = pvp.seasonNo ?? 1;
      if (lastSeen > 0 && currentSeason > lastSeen) {
        // Season transitioned — show the settlement overlay once.
        const peakRank = pvp.seasonPeakRank ?? pvp.rank;
        lobby.showSeasonSettlement(lastSeen, peakRank, currentSeason);
      }
      platform.storage.setItem(LAST_SEEN_SEASON_KEY, String(currentSeason));
    }

    // Paint the cached social total immediately so the dot survives a resize
    // rebuild without flicker; then refresh from the server (skip on resize).
    lobby.applySocialBadge(socialBadgeTotal);
    lobby.applyAchievementBadge(achievementClaimable);
    // Ping worldsvc so the world-map nav button shows a "×" badge immediately when
    // the service isn't running — visible feedback before the user clicks the button.
    if (getWorldBaseUrl()) {
      const worldHealthApi = new WorldApiClient(platform.storage);
      void worldHealthApi.checkHealth().then((ok) => { if (inLobby) lobby.applyWorldAvailable(ok); });
    }
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
      if (!opts?.fromResize) void refreshAchievementBadge(lobby);
      if (!opts?.fromResize) void refreshRetentionBadge(lobby);
      if (!opts?.fromResize) void refreshEventsAvailable(lobby);
    } else {
      socialBadgeTotal = 0;
      achievementClaimable = false;
      achievementReached = null; // drop the unlock baseline so a later login re-seeds without a stale toast
    }
  }

  function goSettings(): void {
    inLobby = false;
    analytics.track('screen_view', { scene: 'SettingsScene' });
    const pvp = saveManager.get().pvp;
    const loggedIn = !offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    const canRename = !offlineMode && !!api && loggedIn;
    views.showSettings({
      onBack() { goLobby(); },
      playerName: playerName(),
      avatarId: avatarId(),
      onSetAvatar: (id) => { platform.storage.setItem(PLAYER_AVATAR_KEY, id); },
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
      // Account deletion (C5-b): only available when logged in online (no account to delete when offline).
      ...(loggedIn && !!api ? { onDeleteAccount: doDeleteAccount } : {}),
      // Replay tutorial (ONBOARDING_DESIGN §3.4): directly re-runs the dedicated tutorial level (never fails, can be skipped again).
      onReplayTutorial: () => goTutorial(),
    });
  }

  /**
   * Delete account (C5-b, Apple 5.1.1(v)): call the soft-delete endpoint → clear the local
   * token / display name / public id → return to the login screen. (Accounts can be recovered
   * within a 7-day grace period by logging in again; the confirmation dialog explains this.)
   * On failure, return ok:false so the settings screen can show a toast.
   */
  async function doDeleteAccount(): Promise<{ ok: boolean }> {
    if (!api) return { ok: false };
    try {
      await api.deleteAccount();
      analytics.track('account_delete', {});
      platform.storage.removeItem(TOKEN_KEY);
      platform.storage.removeItem(PLAYER_NAME_KEY);
      platform.storage.removeItem(PLAYER_PUBLIC_ID_KEY);
      api.setToken(null);
      goLogin();
      return { ok: true };
    } catch (e) {
      console.error('[account] delete failed', e);
      return { ok: false };
    }
  }

  /** Title wall (S10). Entered from the "Career" top bar (back=goStats); no longer accessible from settings. */
  function goTitles(back: () => void = goStats): void {
    const save = saveManager.get();
    views.showTitles({
      onBack() { back(); },
      titles: save.titles ?? [],
      equippedTitle: save.equipped['title'] ?? '',
      onEquip(titleId: string) {
        saveManager.update((d) => { d.equipped['title'] = titleId; });
      },
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
      // Immediately re-fetch the bootstrap after receiving publicId so targeted log capture
      // takes effect without waiting for the next 120-second polling cycle (best-effort).
      void featureFlags?.refresh();
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

  function goDeckBuilder(onSave: (deck: string[]) => void): void {
    const save = saveManager.get();
    views.showDeckBuilder({
      onSave(deck) {
        saveManager.patchLocal({ pvpDeck: deck });
        onSave(deck);
      },
      onBack() { goLobby(); },
      getCurrentDeck() { return save.pvpDeck; },
      getSeasonPeakElo() { return save.pvp.seasonPeakElo ?? save.pvp.elo; },
    });
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
    const getSavedDeck = (): string[] => {
      const d = saveManager.get().pvpDeck;
      if (d && validatePvpDeckClient(d, saveManager.get().pvp.seasonPeakElo ?? saveManager.get().pvp.elo) === null) return d;
      return defaultPvpDeck();
    };
    let rankedQueued = false;
    const queueRanked = (): void => {
      if (rankedQueued) return;
      rankedQueued = true;
      log.info('entering ranked queue (createRanked)');
      analytics.track('pvp_room_create', { mode: 'ranked' });
      session?.createRanked(getSavedDeck());
    };
    const view: RoomView = views.showRoom({
      available: session !== null,
      autoRanked,
      onBack() {
        session?.close();
        if (session) session.handlers = { onMatchStart: (info) => goGameNet(info) };
        goLobby();
      },
      createRoom() { analytics.track('pvp_room_create', { mode: 'friendly' }); session?.createRoom(); },
      joinRoom(code: string) { session?.joinRoom(code); },
      setReady(ready: boolean) { session?.setReady(ready); },
      startMatch() { session?.startMatch(); },
      createRanked() { analytics.track('pvp_room_create', { mode: 'ranked' }); session?.createRanked(getSavedDeck()); },
      cancelQueue() { rankedQueued = false; session?.cancelQueue(); },
    });

    if (session) {
      session.handlers = {
        onMatchStart: (info) => goGameNet(info),
        // Matchmaking timeout fallback to AI (feature flag match_bot_fallback): server pushes match_bot →
        // exit the queue UI and start a local AI match (using the server-provided seed).
        onMatchBot: (seed) => {
          rankedQueued = false;
          log.info('match_bot fallback → local AI match', { seed });
          goGame({ seed, fromBotFallback: true });
        },
        onRoomState: (s) => view.applyRoomState(s),
        onRoomError: (e) => view.applyRoomError(e),
        onPeerDc:    (p) => view.applyPeerDc(p),
        onNetState:  (s) => {
          view.applyNetState(s);
          if (autoRanked && s === 'open') queueRanked();
        },
      };
      session.connect();
      // If the gateway was already open from the lobby phase, connect() is a no-op
      // and onNetState('open') will never fire — deliver it synchronously now.
      if (session.gateway.getState() === 'open') {
        view.applyNetState('open');
        if (autoRanked) queueRanked();
      }
    }
  }

  function goFriends(opts?: { defaultTab?: 'friends' | 'mail' }): void {
    // Social needs a server account; offline / no API → bounce to login.
    if (!api) { analytics.track('login_gate_hit', { scene: 'FriendsScene' }); goLogin(); return; }
    analytics.track('screen_view', { scene: 'FriendsScene' });
    const client = api;
    inLobby = false;
    const session = getNetSession();
    // Restore the default match-start handler when leaving (mirrors goRoom).
    const restore = (): void => {
      if (session) session.handlers = { onMatchStart: (info) => goGameNet(info) };
    };

    // SLG world API — lazy worldId resolved on first SLG-tab visit.
    // getWorldBaseUrl() returns '' in Docker/prod (same-origin nginx proxy) — falsy
    // but still valid. Do NOT guard on empty string; worldsvc is always reachable.
    const worldApi = new WorldApiClient(platform.storage);
    let slgWorldId: string | null = null;
    const ensureWorldId = async (): Promise<string> => {
      if (slgWorldId) return slgWorldId;
      if (!worldApi) throw new Error('no world api');
      const w = await worldApi.resolveSeason(CURRENT_SEASON);
      slgWorldId = w.worldId;
      return slgWorldId;
    };

    const view: FriendsView = views.showFriends({
      onBack() { restore(); goLobby(); },
      onOpenRoom() { goRoom(); },
      ...(opts?.defaultTab ? { defaultTab: opts.defaultTab } : {}),
      loadFriends: () => client.getFriends(),
      loadRequests: () => client.getFriendRequests(),
      search: (publicId) => client.searchFriend(publicId),
      addFriend: async (publicId) => { await client.requestFriend(publicId); },
      respond: async (requestId, accept) => {
        const r = await client.respondFriend(requestId, accept);
        if (accept) analytics.track('friend_add', {});
        return r;
      },
      removeFriend: (publicId) => client.removeFriend(publicId),
      blockUser: (publicId) => client.blockUser(publicId),
      // Direct messages (entry point is the friend profile popup)
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
      // SLG social tab (S6-4)
      ...(worldApi ? {
        async loadSLGStatus() {
          const wid = await ensureWorldId();
          const me = await worldApi.getMe(wid);
          const myAccountId = platform.storage.getItem('nw_account_id') ?? '';
          const status: import('../scenes/FriendsScene').SLGSocialStatus = {
            worldId: wid,
            familyId: me.familyId,
            isLeader: false,
          };
          if (me.familyId) {
            try {
              const fam = await worldApi.getFamily(me.familyId);
              status.familyName = fam.name;
              status.familyTag = fam.tag;
              status.sectId = fam.sectId;
              status.isLeader = !!myAccountId && fam.leaderId === myAccountId;
              if (fam.sectId) {
                try {
                  const sect = await worldApi.getSect(fam.sectId);
                  status.sectName = sect.name;
                } catch { /* missing sect is non-fatal */ }
              }
            } catch { /* missing family is non-fatal */ }
          }
          return status;
        },
        createFamily: async (name, tag) => { await worldApi.createFamily(name, tag); },
        joinFamily:   async (familyId) => { await worldApi.joinFamily(familyId); },
        createSect:   async (name, tag) => { const wid = await ensureWorldId(); await worldApi.createSect(wid, name, tag); },
        joinSect:     async (sectId) => { const wid = await ensureWorldId(); await worldApi.joinSect(wid, sectId); },
        openFamilyHub: () => { if (slgWorldId) goFamilyHub(worldApi, slgWorldId); },
        openSectHub:   () => { if (slgWorldId) goSectHub(worldApi, slgWorldId); },
        loadWorldChat: async (before) => { const wid = await ensureWorldId(); return worldApi.getWorldChannel(wid, { before }); },
        sendWorldChat: async (body, senderName) => { const wid = await ensureWorldId(); await worldApi.sendWorldChannelMessage(wid, body, senderName); },
        playerName: () => platform.storage.getItem(PLAYER_PUBLIC_ID_KEY) ?? '',
      } : {}),
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

  /** Right-column mail shortcut → opens FriendsScene directly on the mail tab. */
  function goMail(): void { goFriends({ defaultTab: 'mail' }); }

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
    // Note: getWorldBaseUrl() returns '' in Docker/production (same-origin nginx proxy,
    // where /world/* is forwarded to worldsvc). Do NOT guard on empty string — it is valid.
    const token = platform.storage.getItem(TOKEN_KEY);
    if (!token) { analytics.track('login_gate_hit', { scene: 'WorldMapScene' }); goLogin(); return; }
    const worldApi = new WorldApiClient(platform.storage);
    inLobby = false;
    // G6/§20: resolve the shard for this account based on the current season (sticky > family > random,
    // overflow opens a new shard); worldId is no longer hard-coded.
    // CURRENT_SEASON is temporarily a client-side constant; metaserver will supply it once S11 ladder-season
    // metadata is delivered (§20.8).
    // 3-second timeout prevents the button from hanging when worldsvc is not running
    // (Windows Firewall may drop TCP RST, causing long waits).
    const fallbackId = `s${CURRENT_SEASON}-0`;
    let navigated = false;
    const nav = (worldId: string): void => { if (!navigated) { navigated = true; goWorldMap(worldApi, worldId); } };
    const timer = setTimeout(() => nav(fallbackId), 3000);
    void worldApi.resolveSeason(CURRENT_SEASON)
      .then((r) => { clearTimeout(timer); nav(r.worldId); })
      .catch(() => { clearTimeout(timer); nav(fallbackId); });
  }

  function goWorldMap(worldApi: WorldApiClient, worldId: string): void {
    inLobby = false;
    const view = views.showWorldMap({
      onBack() { goLobby(); },
      onOpenFamily() { goFamilyHub(worldApi, worldId); },
      onOpenAuction() { goAuctionHouse(worldApi, worldId); },
      onReplaySiege(siegeId) { void goSiegeReplay(worldApi, worldId, siegeId); },
      onOpenDefense(tileKey) { goDefenseEditor(worldApi, worldId, tileKey); },
      onOpenTeams() { goTeams(worldApi, worldId); },
      worldApi,
      worldId,
      playerName: playerName(),
      accountId: platform.storage.getItem('nw_account_id') ?? '',
      getCoins: () => saveManager.get().wallet.coins,
    });
    // Keep the gateway connected + forward SLG pushes into the live map handle
    // (march/tile/under-attack/siege incremental refresh, §14.5).
    const session = getNetSession();
    if (session) {
      session.handlers = {
        onMatchStart: (info) => goGameNet(info),
        onMarchUpdate: (m) => view.applyMarchUpdate(m),
        onTileUpdate:  (tu) => view.applyTileUpdate(tu),
        onUnderAttack: (u) => view.applyUnderAttack(u),
        onSiegeResult: (s) => view.applySiegeResult(s),
      };
      session.connect();
    }
  }

  /**
   * Watch a settled siege replay (G3-2c §16.3). worldsvc has already run the authoritative battle
   * headlessly and persisted the result — this is **pure presentation replay** (non-authoritative,
   * no recording upload, no judge): fetch `/replay` (seed + LevelDefinition reconstructed from both
   * sides' formations) → re-run in siege spectator mode with the same seed + an empty
   * ReplayInputSource, reproducing exactly what worldsvc executed. Both attackers and defenders
   * can watch.
   */
  async function goSiegeReplay(worldApi: WorldApiClient, worldId: string, siegeId: string): Promise<void> {
    let level: LevelDefinition;
    let seed = 0;
    try {
      const data = await worldApi.getSiegeReplay(worldId, siegeId);
      level = data.level as unknown as LevelDefinition;
      seed = data.seed;
    } catch {
      goWorldMap(worldApi, worldId);
      return;
    }
    inLobby = false;
    analytics.track('siege_replay', { siege_id: siegeId });
    // Pure pre-placement with no live commands → empty frames; endFrame is set to the battle
    // timeout plus a buffer as the playback upper bound (game-over will actually stop it first).
    const SIEGE_TIMEOUT_FALLBACK = 10 * 60 * 30; // §16.1 DRAFT, matches server default
    const endFrame = (level.battleTimeoutTicks ?? SIEGE_TIMEOUT_FALLBACK) + 600;
    const replay: Replay = { engineVersion: ENGINE_VERSION, mode: 'siege', seed, frames: [], endFrame };
    views.showReplay(replay, { onExit() { goWorldMap(worldApi, worldId); } }, level);
  }

  /** Open the simplified defense editor (C3) for a tile; returns to the map on back. */
  function goDefenseEditor(worldApi: WorldApiClient, worldId: string, tileKey: string): void {
    inLobby = false;
    views.showDefenseEditor({
      onBack() { goWorldMap(worldApi, worldId); },
      worldApi,
      worldId,
      target: { mode: 'defense', tileKey },
    });
  }

  /** Open the attack-team list (G3-2c); back → map, edit → team formation editor. */
  function goTeams(worldApi: WorldApiClient, worldId: string): void {
    inLobby = false;
    views.showTeams({
      onBack() { goWorldMap(worldApi, worldId); },
      onEditTeam(teamId, teamName) { goTeamEditor(worldApi, worldId, teamId, teamName); },
      worldApi,
      worldId,
    });
  }

  /** Open the formation editor for one attack-team slot; back → team list. */
  function goTeamEditor(worldApi: WorldApiClient, worldId: string, teamId: string, teamName: string): void {
    inLobby = false;
    views.showDefenseEditor({
      onBack() { goTeams(worldApi, worldId); },
      worldApi,
      worldId,
      target: { mode: 'attack', teamId, teamName },
    });
  }

  function goFamilyHub(worldApi: WorldApiClient, worldId: string): void {
    const myAccountId = platform.storage.getItem('nw_account_id') ?? '';
    views.showFamily({
      onBack() { goWorldMap(worldApi, worldId); },
      onOpenSect() { goSectHub(worldApi, worldId); },
      worldApi,
      worldId,
      myAccountId,
    });
  }

  function goSectHub(worldApi: WorldApiClient, worldId: string): void {
    const myAccountId = platform.storage.getItem('nw_account_id') ?? '';
    const view = views.showSect({
      onBack() { goFamilyHub(worldApi, worldId); },
      worldApi,
      worldId,
      myAccountId,
      playerName: playerName(),
    });
    // Keep the gateway connected + forward live sect-channel messages into the scene
    // (S8-4b: worldsvc → Redis pub/sub → gateway → here). Offline → REST history poll.
    const session = getNetSession();
    if (session) {
      session.handlers = {
        onMatchStart: (info) => goGameNet(info),
        onSectMsg: (s) => view.applySectMsg({
          id: `push:${s.ts}:${s.fromPublicId}`,
          senderId: s.fromPublicId,
          senderName: s.fromName,
          body: s.text,
          ts: s.ts,
        }),
      };
      session.connect();
    }
  }

  function goAuctionHouse(worldApi: WorldApiClient, worldId: string): void {
    views.showAuction({
      onBack() { goWorldMap(worldApi, worldId); },
      worldApi,
      worldId,
    });
  }

  function goShop(onBack?: () => void): void {
    if (!api) { goLobby(); return; }
    const client = api;
    inLobby = false;
    analytics.track('shop_open', {});
    analytics.track('screen_view', { scene: 'ShopScene' });
    // Conversion flag: whether a purchase was made during this shop visit; reported with shop_close on exit (funnel bottom, §9.3).
    let converted = false;
    const shopOpenTs = Date.now();
    // Battle pass merged into the shop (LOBBY_IA_REDESIGN §3): the battle-pass entry is only shown when logged in online; back returns to the shop.
    const shopLoggedIn = !offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    views.showShop({
      onBack() {
        analytics.track('shop_close', { converted, time_sec: Math.round((Date.now() - shopOpenTs) / 1000) });
        if (onBack) onBack(); else goLobby();
      },
      getCoins: () => saveManager.get().wallet.coins,
      getOwnedSkins: () => saveManager.get().inventory.skins,
      loadItems: () => client.getShopItems(),
      async buy(itemId) {
        try {
          const { save } = await client.shopBuy(itemId);
          saveManager.adoptServer(save);
          converted = true;
          analytics.track('shop_buy', { item_id: itemId, currency: 'coins' });
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
        try {
          const { save } = await client.iapVerify('dev', code);
          saveManager.adoptServer(save);
          return { ok: true };
        } catch {
          return { ok: false, key: 'shop.error' };
        }
      },
      // Shop group peer tabs (LOBBY_IA_REDESIGN P1.5): gacha / battle pass promoted to top tabs;
      // threading shopBack lets all three pages navigate to each other and return to the same origin (lobby / level-prep).
      openGacha() { goGacha({ shopBack: onBack }); },
      ...(shopLoggedIn ? { openBattlePass: () => goBattlePass({ shopBack: onBack }) } : {}),
    });
  }

  /**
   * Gacha / loot box (S2-6). When `group` is provided = shop-group context (top [Shop|Gacha|BattlePass]
   * tab bar with peer navigation); omitted = standalone entry (back returns to the shop only).
   */
  function goGacha(group?: { shopBack?: () => void }): void {
    if (!api) { goLobby(); return; }
    const client = api;
    inLobby = false;
    analytics.track('screen_view', { scene: 'GachaScene' });
    const inGroup = !!group;
    const shopBack = group?.shopBack;
    const bpAvail = !offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    views.showGacha({
      onBack() { goShop(shopBack); },
      ...(inGroup ? { openShop: () => goShop(shopBack) } : {}),
      ...(inGroup && bpAvail ? { openBattlePass: () => goBattlePass({ shopBack }) } : {}),
      getCoins: () => saveManager.get().wallet.coins,
      getPity: (poolId) => saveManager.get().gacha.pity[poolId] ?? 0,
      loadPools: () => client.getGachaPools(),
      async draw(poolId, count) {
        try {
          const { save, results } = await client.gachaDraw(poolId, count);
          saveManager.adoptServer(save);
          analytics.track('gacha_draw', { pool_id: poolId, count });
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

  /** Daily check-in + daily quests (B5). Server-authoritative; requires an online login; entered from the lobby, returns to the lobby. */
  function goDaily(): void {
    if (!api) { goLobby(); return; }
    const client = api;
    inLobby = false;
    analytics.track('screen_view', { scene: 'DailyScene' });
    // Fetch the authoritative save once on entering the daily page so that retention progress
    // from a completed PvP/PvE session is shown immediately.
    void saveManager.refresh();
    views.showDaily({
      onBack() { goLobby(); },
      getSave: () => saveManager.get(),
      getRetention: () => client.getRetention(),
      async onCheckin() {
        const { save, day, reward } = await client.claimCheckin();
        saveManager.adoptServer(save);
        analytics.track('daily_checkin', { day });
        return { day, reward };
      },
      async onClaimDaily() {
        const { save, coins } = await client.claimDailyReward();
        saveManager.adoptServer(save);
        analytics.track('daily_reward_claim', { coins });
        return { coins };
      },
    });
  }

  /** Limited-time events (B6). Server-authoritative; requires an online login; entered from the lobby, returns to the lobby. */
  function goEvents(): void {
    if (!api) { goLobby(); return; }
    const client = api;
    inLobby = false;
    analytics.track('screen_view', { scene: 'EventScene' });
    views.showEvents({
      onBack() { goLobby(); },
      getEvents: () => client.getEvents(),
      async onClaimReward(eventId: string, rewardId: string) {
        const { pointsLeft } = await client.claimEventReward(eventId, rewardId);
        analytics.track('event_claim', { event_id: eventId, reward_id: rewardId });
        // Reward delivered via mail / commercial coins → fetch the authoritative save once to refresh the wallet (best-effort).
        void saveManager.refresh();
        return { pointsLeft };
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

  /**
   * Local PvP-vs-AI match. `opts.fromBotFallback` = triggered by a matchmaking-timeout fallback
   * (feature flag match_bot_fallback): uses the server-supplied seed for determinism; analytics
   * tags distinguish intentional practice from bot-fallback sessions.
   */
  function goGame(opts?: { seed?: number; fromBotFallback?: boolean }): void {
    inLobby = false;
    platform.onGameplayStart();
    const mode = opts?.fromBotFallback ? 'pvp_bot_fallback' : 'pvp_ai';
    analytics.track('game_start', { mode });
    const gameStartTs = Date.now();
    views.showGame({
      onGameEnd(winner, stats, replay) {
        analytics.track('game_end', {
          mode,
          result: winner === 0 ? 'win' : winner === 1 ? 'loss' : 'draw',
          duration_sec: Math.round((Date.now() - gameStartTs) / 1000),
        });
        goResult(winner, stats, 0, keepReplay(replay));
      },
      onExitToLobby() {
        analytics.track('game_end', { mode, result: 'abandon', duration_ticks: 0 });
        goLobby();
      },
    }, {
      equippedSkin: saveManager.get().equipped[EQUIP_SLOT] ?? null,
      ...(opts?.seed !== undefined ? { seed: opts.seed } : {}),
    });
  }

  function goCampaignMap(): void {
    inLobby = false;
    analytics.track('screen_view', { scene: 'CampaignMapScene' });
    views.showCampaignMap({
      onBack() { goLobby(); },
      onSelectLevel(levelId) { goLevelPrep(levelId); },
      onOpenCollection() { goCollection(goCampaignMap, 'skins'); },
      // Equipment system is server-authoritative (enhancement rolls / coin deduction / inventory) → entry only available when logged in online (E5).
      ...(api ? { onOpenEquipment: () => goEquipment() } : {}),
      getStars: () => saveManager.get().progress.stars,
      getCleared: () => saveManager.get().progress.cleared,
      // PvE is server-authoritative: clearing / unlocking new levels requires an online connection (§8 decision 4). Offline, only previously unlocked levels can be replayed; new unlocks are gated.
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
    analytics.track('screen_view', { scene: 'LevelPrepScene' });
    views.showLevelPrep({
      onBack() { analytics.track('level_abandon', { level_id: levelId, phase: 'prep' }); goCampaignMap(); },
      onStart() { analytics.track('screen_view', { scene: 'GameScene' }); goCampaign(levelId); },
      levelNumber,
      // S12: unit levels + card inventory (merge system), replacing the old S3-2 material / upgrade-tree approach.
      getUnitLevels: () => saveManager.get().unitLevels,
      getCardInventory: () => saveManager.get().cardInventory,
      isOnline: () => saveManager.online(),
      tryMerge: async (unitId, lvl) => {
        const ok = await saveManager.merge(unitId, lvl);
        if (ok) analytics.track('unit_card_merge', { unit_id: unitId, from_level: lvl });
        return ok;
      },
      ...(level.briefKey ? { brief: t(level.briefKey as TranslationKey) } : {}),
      ...(level.story?.introKey ? { intro: t(level.story.introKey as TranslationKey) } : {}),
      // A4 stamina system
      staminaCost: level.staminaCost ?? 1,
      getStamina: () => saveManager.get().stamina ?? { current: 120, regenAt: 0 },
      onBuyStamina() {
        if (!api) return;
        void api.purchaseStamina().then((res) => {
          // Update the local stamina mirror, then re-enter LevelPrep to refresh the UI.
          saveManager.update((s) => { s.stamina = res.stamina; });
          goLevelPrep(levelId);
        }).catch(() => {
          // Insufficient coins: fail silently → fall back to the shop route
          goShop(() => goLevelPrep(levelId));
        });
      },
    });
  }

  function goCollection(back: () => void, initialTab: 'cards' | 'skins' | 'units' = 'cards'): void {
    inLobby = false;
    analytics.track('screen_view', { scene: 'CollectionScene' });
    // Equipment merged into the "Growth" section (LOBBY_IA_REDESIGN §3): the 4th "Equipment" tab
    // is only active when logged in online; back from equipment returns to this collection page
    // (preserving the active sub-tab).
    const equipLoggedIn = !offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    views.showCollection({
      onBack: back,
      initialTab,
      ...(api && equipLoggedIn ? { onOpenEquipment: () => goEquipment(() => goCollection(back, initialTab), true) } : {}),
      getSkins: () => saveManager.get().inventory.skins,
      getEquipped: () => saveManager.get().equipped[EQUIP_SLOT] ?? null,
      equip: (skinId) => {
        saveManager.update((d) => {
          if (skinId === null) delete d.equipped[EQUIP_SLOT];
          else d.equipped[EQUIP_SLOT] = skinId;
        });
      },
      // S12 unit card tab
      getUnitLevels: () => saveManager.get().unitLevels,
      getCardInventory: () => saveManager.get().cardInventory,
      isOnline: () => saveManager.online(),
      tryMerge: async (unitId, lvl) => {
        const ok = await saveManager.merge(unitId, lvl);
        if (ok) analytics.track('unit_card_merge', { unit_id: unitId, from_level: lvl });
        return ok;
      },
    });
  }

  /** Map equipment endpoint error codes → i18n key (E5). */
  function equipErrKey(e: unknown): TranslationKey {
    if (e instanceof ApiError) {
      switch (e.code) {
        case 'INSUFFICIENT_MATERIALS': return 'equip.err.materials';
        case 'INSUFFICIENT_FUNDS':     return 'equip.err.coins';
        case 'INVENTORY_FULL':         return 'equip.err.full';
        case 'ENHANCE_MAX_LEVEL':      return 'equip.err.maxLevel';
        case 'NOT_SALVAGEABLE':        return 'equip.err.notSalvageable';
        case 'INVALID_SLOT':           return 'equip.err.invalidSlot';
        case 'EQUIP_LOCKED':           return 'equip.err.locked';
        case 'EQUIP_IN_USE':           return 'equip.err.inUse';
        case 'NOT_REFORGE_ELIGIBLE':   return 'equip.err.notReforgeEligible';
        case 'INVALID_RARITY':         return 'equip.err.invalidRarity';
      }
    }
    return 'equip.err.generic';
  }

  /**
   * Equipment system (E5). Server-authoritative; requires an online login. Can be entered from
   * the campaign map (default back) or the "Growth" tab (LOBBY_IA_REDESIGN §3, back=collection page);
   * `back` determines where the user returns to.
   */
  function goEquipment(back: () => void = goCampaignMap, inCollectionGroup = false): void {
    if (!api) { back(); return; }
    const client = api;
    inLobby = false;
    analytics.track('screen_view', { scene: 'EquipmentScene' });
    views.showEquipment({
      onBack() { back(); },
      // Growth group peer tabs (LOBBY_IA_REDESIGN P1.5): when entered from the collection page, a
      // top [Collection|Equipment] tab bar is shown; tapping Collection navigates back to growth (= back).
      // Campaign-map entry (back=goCampaignMap) does not inject this → plain back only.
      ...(inCollectionGroup ? { openCollection: () => back() } : {}),
      getSave: () => saveManager.get(),
      async craft(defId: string) {
        try {
          const { save } = await client.craftEquipment(defId, genUuid());
          saveManager.adoptServer(save);
          analytics.track('equip_craft', { def_id: defId });
          return { ok: true as const };
        } catch (e) { return { ok: false as const, key: equipErrKey(e) }; }
      },
      async enhance(instanceId: string, useProtect?: boolean) {
        try {
          const { success, instance, save } = await client.enhanceEquipment(instanceId, genUuid(), useProtect);
          saveManager.adoptServer(save);
          analytics.track('equip_enhance', { def_id: instance.defId, from_level: instance.level - (success ? 1 : 0), success, use_protect: !!useProtect });
          return { ok: true as const, success, level: instance.level };
        } catch (e) { return { ok: false as const, key: equipErrKey(e) }; }
      },
      async salvage(instanceIds: string[]) {
        try {
          const { save } = await client.salvageEquipment(instanceIds, genUuid());
          saveManager.adoptServer(save);
          analytics.track('equip_salvage', { count: instanceIds.length });
          return { ok: true as const };
        } catch (e) { return { ok: false as const, key: equipErrKey(e) }; }
      },
      async equip(slot: EquipSlot, instanceId: string | null) {
        try {
          const { save } = await client.equipEquipment(slot, instanceId);
          saveManager.adoptServer(save);
          analytics.track('equip_equip', { slot, instance_id: instanceId ?? '' });
          return { ok: true as const };
        } catch (e) { return { ok: false as const, key: equipErrKey(e) }; }
      },
      async reforge(targetId: string, materialId: string) {
        try {
          const { save } = await client.reforgeEquipment(targetId, materialId, genUuid());
          saveManager.adoptServer(save);
          analytics.track('equip_reforge', { target_id: targetId });
          return { ok: true as const };
        } catch (e) { return { ok: false as const, key: equipErrKey(e) }; }
      },
    });
  }

  function goStats(): void {
    inLobby = false;
    analytics.track('screen_view', { scene: 'StatsScene' });
    const loggedIn = !offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    const client = api;
    const pvp = saveManager.get().pvp;
    views.showStats({
      onBack: () => goLobby(),
      // Fetch server-side match history and enable replay viewing only when logged in online;
      // offline / not logged in: omit these (the page shows an offline notice).
      ...(client && loggedIn
        ? {
            loadHistory: () => client.getMatchHistory(),
            onWatchReplay: (roomId: string) => {
              void client
                .getMatchReplay(roomId)
                .then((sr) => goReplay(serverReplayToReplay(sr), goStats))
                .catch(() => {
                  /* Replay missing or decode failed: best-effort, stay on stats */
                });
            },
          }
        : {}),
      ...(client && loggedIn ? { onOpenAchievements: () => goAchievements(), hasClaimableAchievement: achievementClaimable } : {}),
      ...(client && loggedIn ? { onOpenLeaderboard: () => goLeaderboard() } : {}),
      // Titles merged into the "Career" top bar (LOBBY_IA_REDESIGN §3); battle pass has moved to the "Shop" tab and is no longer linked here.
      ...(loggedIn ? { onOpenTitles: () => goTitles(goStats) } : {}),
      // Season banner: read from save pvp.seasonNo; endAt comes from the leaderboard cache or stays undefined (displays "ended").
      ...(pvp.seasonNo ? { season: { seasonNo: pvp.seasonNo, endAt: 0 } } : {}),
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

  function goLeaderboard(): void {
    inLobby = false;
    analytics.track('screen_view', { scene: 'LeaderboardScene' });
    const loggedIn = !offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    const client = api;
    views.showLeaderboard({
      onBack: () => goStats(),
      ...(client && loggedIn
        ? { loadLeaderboard: () => client.getLeaderboard() }
        : {}),
    });
  }

  /**
   * Battle pass (SE-9). When `group` is provided = shop-group context (top [Shop|Gacha|BattlePass]
   * tab bar, back returns to the shop); omitted = standalone entry (back returns to the lobby).
   * After the IA redesign, this is entered from the "Shop" tab (LOBBY_IA_REDESIGN §3);
   * `back` determines where the user returns to.
   */
  function goBattlePass(group?: { shopBack?: () => void }): void {
    inLobby = false;
    analytics.track('screen_view', { scene: 'BattlePassScene' });
    const loggedIn = !offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    const client = api;
    const inGroup = !!group;
    const shopBack = group?.shopBack;
    views.showBattlePass({
      onBack: inGroup ? () => goShop(shopBack) : goLobby,
      ...(inGroup ? { openShop: () => goShop(shopBack), openGacha: () => goGacha({ shopBack }) } : {}),
      ...(loggedIn
        ? {
            getBattlePass: () => saveManager.get().battlePass,
            ...(client
              ? {
                  onBuy: async () => {
                    const { battlePass } = await client.buyBattlePass();
                    if (battlePass) saveManager.adoptServer({ ...saveManager.get(), battlePass });
                    analytics.track('battlepass_buy', {});
                  },
                  onClaim: async (track: 'free' | 'paid', level: number) => {
                    const { battlePass, reward } = await client.claimBattlePass(track, level);
                    if (battlePass) saveManager.adoptServer({ ...saveManager.get(), battlePass });
                    analytics.track('battlepass_claim', { track, level, reward_kind: reward.kind, reward_count: reward.count });
                    return reward.kind === 'coins' ? reward.count : 0;
                  },
                }
              : {}),
          }
        : {}),
    });
  }

  function goAchievements(): void {
    inLobby = false;
    analytics.track('screen_view', { scene: 'AchievementScene' });
    // Mid-funnel achievement step (S9-8, ANALYTICS_DESIGN §5.7): unlock toast → view wall → claim. Only counts as a valid funnel step when online.
    const onlineWall = !offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    analytics.track('achievement_view_wall', { online: onlineWall });
    const loggedIn = !offlineMode && !!platform.storage.getItem(TOKEN_KEY);
    const client = api;
    views.showAchievements({
      onBack: () => goStats(),
      // Fetch achievements and enable claiming only when logged in online;
      // offline / not logged in: the page shows a "log in to view" message.
      ...(client && loggedIn
        ? {
            loadAchievements: () => client.getAchievements(),
            onClaim: async (achId: string, tier: number) => {
              const { save, granted } = await client.claimAchievement(achId, tier);
              saveManager.adoptServer(save);
              analytics.track('achievement_claim', { ach_id: achId, tier, coins: granted });
              return granted;
            },
          }
        : {}),
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
        // Persist the replay to disk first (once), serving both the result-screen playback and
        // potential L1 spot-check re-evaluation (§8.6).
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
          // Server-authoritative settlement (§8): online → POST /pve/clear (if selected for spot-check,
          // the kept replay is submitted via /pve/verify for re-evaluation);
          // offline → enqueue for deferred settlement (fire-and-forget; save / pending are re-read on
          // returning to CampaignMap to reflect the state).
          if (stars > 0) void saveManager.recordClear(levelId, stars, kept, achievementStatDelta(stats[0]));
        } else {
          analytics.track('game_end', {
            mode: 'campaign',
            result: 'loss',
            level_id: levelId,
            duration_sec: durationSec,
          });
        }
        const outroText = (winner === 0 && level.story?.outroKey) ? t(level.story.outroKey as TranslationKey) : undefined;
        void goResult(winner, stats, 0, kept, undefined, undefined, outroText, goCampaignMap, t('result.backToMap'));
      },
      onExitToLobby() {
        analytics.track('level_abandon', { level_id: levelId, phase: 'in_game' });
        goLobby();
      },
    }, {
      level,
      unitLevels: saveManager.get().unitLevels,
      equippedSkin: saveManager.get().equipped[EQUIP_SLOT] ?? null,
      equipment: { gear: saveManager.get().gear, inv: saveManager.get().equipmentInv },
    });
  }

  /**
   * Dedicated tutorial level ch0_tutorial (FTUE step ⑤, ONBOARDING_DESIGN §3). Never fails: the
   * director owns the endgame, so winner is always the local player. Both completion and skip write
   * tutorial_done then return to the lobby; does not count toward campaign progress (recordClear is
   * not called).
   */
  function goTutorial(): void {
    const level = getLevel(TUTORIAL_LEVEL_ID);
    if (!level) { goLobby(); return; }  // If the tutorial level is missing, skip silently rather than blocking new players.
    inLobby = false;
    platform.onGameplayStart();
    analytics.track('tutorial_start', { level_id: TUTORIAL_LEVEL_ID });
    views.showGame({
      onGameEnd(_winner, _stats, _replay) {
        saveManager.setFlag(TUTORIAL_DONE_FLAG, true);
        analytics.track('tutorial_complete', { level_id: TUTORIAL_LEVEL_ID });
        // §5 first-win hook: graduation = first win; the daily check-in is surfaced via the lobby red dot, so no additional coin source is added here.
        goLobby();
      },
      onExitToLobby() {  // Skip tutorial
        saveManager.setFlag(TUTORIAL_DONE_FLAG, true);
        analytics.track('tutorial_skip', { step: 'tutorial' });
        goLobby();
      },
    }, { level, tutorial: true });
  }

  function goReplay(replay: Replay, onExit: () => void = goLobby): void {
    inLobby = false;
    platform.onGameplayStart();
    views.showReplay(replay, {
      onExit() { onExit(); },
      ...(api ? { onShare: () => void doShareReplay({ mode: replay.mode, winner: replay.meta?.winner }) } : {}),
    });
  }

  /**
   * Share the in-memory state-stream replay (REPLAY_SHARE_DESIGN §4.3). Reads the {@link stateRecorder}
   * single slot → uploads to mint a share code → platform share (Web copy-link / WeChat card).
   * No engine re-run, no server re-evaluation. Requires api (online).
   */
  async function doShareReplay(overrides: { mode?: string; winner?: number } = {}): Promise<void> {
    if (!api) return;
    const players = [
      { name: playerName(), side: 0 as const },
      { name: '', side: 1 as const },
    ];
    const enc = stateRecorder.build({ ...overrides, players });
    if (!enc) return;
    try {
      const { shareCode } = await api.createStateReplayShare(enc);
      await platform.shareReplay(shareCode, t('share.title'));
    } catch (e) {
      // Classify share failures by cause for debugging and future UI feedback. The two most common
      // reasons: payload too large (this match was too long, still exceeds the limit after compression)
      // / minting rate-limited (too many shares in a short window). All others are treated as network / unknown.
      const code = e instanceof ApiError ? e.code : null;
      const reason =
        code === 'BAD_REQUEST' ? 'too_large' : code === 'RATE_LIMITED' ? 'rate_limited' : 'error';
      log.error('state replay share failed', { reason, err: String(e) });
    }
  }

  /**
   * Deep-link to the mute state player without login (REPLAY_SHARE_DESIGN §4.1): anonymously fetch
   * the blob by share code → decode → enter StatePlayerScene. On failure (not found / expired /
   * network error) fall back to the login screen (which includes a play-demo entry).
   */
  async function goStatePlayer(shareCode: string): Promise<void> {
    inLobby = false;
    if (!api) { goLogin(); return; }
    try {
      const { blob } = await api.getStateReplayShare(shareCode);
      const enc = blob as EncodedStateReplay;
      const replay = decodeStateReplay(enc);
      platform.onGameplayStart();
      views.showStatePlayer(
        replay,
        {
          onPlayDemo() { goLobby({ offline: !api }); },
          onBackToLogin() { goLogin(); },
        },
        enc,
      );
    } catch (e) {
      log.error('open shared state replay failed', { err: String(e) });
      goLogin();
    }
  }

  function goGameNet(info: MatchStartInfo): void {
    const session = netSession;
    if (!session) { goLobby(); return; }
    inLobby = false;
    platform.onGameplayStart();
    const isRankedMode = info.mode === MatchMode.RANKED;
    analytics.track('pvp_match_start', { mode: isRankedMode ? 'ranked' : 'friendly' });
    analytics.track('game_start', { mode: isRankedMode ? 'pvp_ranked' : 'pvp_friendly' });
    const netGameStartTs = Date.now();

    const localOwner = info.localSide as OwnerId;

    const localPvp = saveManager.get().pvp;
    const oppProfile: ProfileData = {
      name: info.opponentName,
      publicId: info.opponentPublicId,
      ...(info.opponentTitle ? { equippedTitle: info.opponentTitle } : {}),
    };
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
      {
        seed: info.seed,
        players: [{ id: 0 }, { id: 1 }],
        mode: 'netplay',
        ...(info.decks ? { decks: { top: info.decks.top, bottom: info.decks.bottom } } : {}),
      },
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
      // Ranked: "play again" re-enters the ranked queue (fresh session), and a
      // secondary "back to lobby" gives an explicit exit. Friendly/AI keep the
      // default (play again == back to lobby), so no extra lobby button there.
      const onPlayAgain = isRanked
        ? () => { session.close(); netSession = null; goRoom({ autoRanked: true }); }
        : undefined;
      const onReturnToLobby = isRanked
        ? () => { session.close(); netSession = null; goLobby(); }
        : undefined;
      void goResult(
        winner, stats, localOwner, keepReplay(replay), elo, profiles,
        undefined, onPlayAgain, undefined, onReturnToLobby,
      );
    };

    const view: NetGameView = views.showGameNet(localOwner, {
      onGameEnd(winner: OwnerId | null, stats: [PlayerStats, PlayerStats]) {
        // S9-6: attach local-side per-match achievement counters (kill.*/cast.*). Meta accumulates only in ranked + L1 verification; friendly matches are ignored.
        session.reportResult(matchStateHash(winner, stats), winner ?? 0, achievementStatDelta(stats[localOwner]));
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
    onPlayAgain?: () => void,
    playAgainLabel?: string,
    onReturnToLobby?: () => void,
  ): Promise<void> {
    inLobby = false;
    platform.onGameplayStop();
    analytics.track('screen_view', { scene: 'ResultScene' });
    await platform.showMidgameAd();
    views.showResult({
      winner,
      stats,
      localOwner,
      ...(elo ? { elo } : {}),
      ...(profiles ? { profiles } : {}),
      ...(outroText ? { outroText } : {}),
      cb: {
        onPlayAgain() { (onPlayAgain ?? goLobby)(); },
        ...(replay ? { onWatchReplay: () => goReplay(replay) } : {}),
        ...(api ? { onShare: () => void doShareReplay({ winner: winner ?? -1 }) } : {}),
        ...(onReturnToLobby ? { onReturnToLobby } : {}),
        ...(playAgainLabel ? { playAgainLabel } : {}),
      },
    });
  }

  function start(): void {
    // Replay share deep-link landing (REPLAY_SHARE_DESIGN §4.1): if the launch parameters contain a share code → skip intro/login and go directly to the mute player.
    const shareCode = platform.getLaunchShareCode();
    if (shareCode && api) {
      void goStatePlayer(shareCode);
      return;
    }
    if (saveManager.getFlag(SEEN_INTRO_FLAG)) {
      gateConsent(() => void resolveEntry());
    } else {
      goIntro();
    }
  }

  function onResized(): void {
    if (inLobby) goLobby({ fromResize: true });
  }

  return { start, onResized };
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
