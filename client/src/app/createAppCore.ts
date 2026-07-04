// createAppCore — the render-free orchestration core of the client. Owns i18n init, SaveManager /
// ApiClient / ReplayStore, the NetSession wiring, and the small set of leaf helpers (session /
// gateway / profile / deck / replay / shard). Every screen transition now lives in a domain nav
// module under app/nav/*; this file assembles them into a single `nav` registry (AppCtx.nav) so the
// modules can call each other without import cycles, and keeps the entry gating (start/onResized).
//
// It talks to the screen layer only through the `AppViews` interface, so the exact same code runs
// under PixiAppViews (real game) and HeadlessAppViews (full-link E2E). It uses only the render-free
// methods of IPlatform — never getCanvas / setupInput — and imports scene types with `import type`
// so PixiJS never leaks into this module's runtime graph.
//
// See app.ts for the thin PIXI shell that constructs PixiAppViews and calls start().

import type { IPlatform } from '../platform/IPlatform';
import type { AppViews } from './AppViews';
import type { Replay } from '../game';
import { initI18n, t } from '../i18n';
import { LocalSaveStore, SaveManager, ReplayStore } from '../game/meta';
import { ApiClient } from '../net/ApiClient';
import { getApiBaseUrl, getGatewayWsUrl } from '../net/config';
import { NetSession } from '../net/NetSession';
import { FeatureFlags } from '../net/featureFlags';
import { showToastMessage } from '../net/log';
import { WorldApiClient } from '../net/WorldApiClient';
import { defaultPvpDeck, validatePvpDeckClient } from '../game/meta/pvpLoadout';
import * as analytics from '../analytics';
import {
  clientPlatformName,
  SEEN_INTRO_FLAG, GDPR_CONSENT_FLAG, TOKEN_KEY, PLAYER_NAME_KEY, PLAYER_PUBLIC_ID_KEY,
  PLAYER_AVATAR_KEY, FALLBACK_SEASON,
} from './appConstants';
import type { AppCtx, AppState, Nav } from './appCtx';
import { createAuthNav } from './nav/auth';
import { createLobbyNav } from './nav/lobby';
import { createRoomNav } from './nav/room';
import { createSocialNav } from './nav/social';
import { createWorldNav } from './nav/world';
import { createShopNav } from './nav/shop';
import { createGameNav } from './nav/game';
import { createResultNav } from './nav/result';

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

  // Mutable session-lifetime state, shared by reference with every nav module.
  const state: AppState = {
    inLobby: false,
    offlineMode: false,
    gatewayUrl: getGatewayWsUrl(platform.storage),
    netSession: null,
    firstLobbyHandled: false,
    socialBadgeTotal: 0,
    achievementClaimable: false,
    achievementReached: null,
  };

  // Navigation registry — populated by the module factories after helpers/ctx are ready.
  // Declared up front so helpers below (and saveManager.onProfile) can reference nav.* lazily.
  const nav = {} as Nav;

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
      if (state.inLobby) nav.goLobby();
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

  // ── Leaf helpers (hoisted; referenced by nav modules via ctx and by callbacks above) ──

  /** Lazily create + cache the NetSession (needs api + a gateway url). */
  function getNetSession(): NetSession | null {
    if (state.netSession) return state.netSession;
    const gw = state.gatewayUrl;
    if (!api || !gw) return null;
    state.netSession = new NetSession(platform, gw, api, () => platform.getAuthCredential());
    state.netSession.handlers.onMatchStart = (info) => nav.goGameNet(info);
    return state.netSession;
  }

  /** Adopt the server-provided gateway WS address (from auth/save). */
  function applyGatewayUrl(url?: string): void {
    if (!url || url === state.gatewayUrl) return;
    state.gatewayUrl = url;
    if (state.netSession) { state.netSession.close(); state.netSession = null; }
    if (state.inLobby) nav.goLobby();
  }

  /** Display name for the profile chip: persisted name, else a generic guest label. */
  function playerName(): string {
    return platform.storage.getItem(PLAYER_NAME_KEY) || t('settings.guest');
  }

  /** Selected avatar token, or undefined for letter-initial fallback. */
  function avatarId(): string | undefined {
    return platform.storage.getItem(PLAYER_AVATAR_KEY) ?? undefined;
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

  /**
   * The player's PvP deck resolved against their *current* ELO (PVP_LOADOUT §3): the saved deck if it
   * still validates, else the default base deck. Shared by ranked queue, friendly rooms, and PvP-vs-AI
   * so all three apply the same unlock gate (a dropped-ELO player loses high-tier units everywhere).
   */
  function resolvePvpDeck(): string[] {
    const d = saveManager.get().pvpDeck;
    if (d && validatePvpDeckClient(d, saveManager.get().pvp.elo) === null) return d;
    return defaultPvpDeck();
  }

  /** Persist a just-finished local match's recording; returns it for the result screen. */
  function keepReplay(replay: Replay | undefined): Replay | undefined {
    if (!replay) return undefined;
    try {
      replayStore.save(replay, replay.meta?.recordedAt ?? Date.now());
    } catch { /* storage full / unavailable — replay still watchable this session */ }
    return replay;
  }

  // G6/§20: resolve the shard for this account based on the current season (sticky > family > random,
  // overflow opens a new shard); worldId is no longer hard-coded. The 3-second timeout prevents the
  // caller from hanging when worldsvc is not running (Windows Firewall may drop TCP RST). Shared by the
  // world-map and lobby-auction entries — both need a resolved worldId before navigating.
  function resolveWorldShard(worldApi: WorldApiClient, then: (worldId: string) => void): void {
    let navigated = false;
    const navTo = (worldId: string): void => { if (!navigated) { navigated = true; then(worldId); } };
    const timer = setTimeout(() => navTo(`s${FALLBACK_SEASON}-0`), 3000);
    void worldApi.getActiveSeason()
      .then((r) => r.season)
      .catch(() => FALLBACK_SEASON)
      .then((season) => worldApi.resolveSeason(season))
      .then((r) => { clearTimeout(timer); navTo(r.worldId); })
      .catch(() => { clearTimeout(timer); navTo(`s${FALLBACK_SEASON}-0`); });
  }

  // ── Assemble the ctx + nav registry ─────────────────────────────────────────
  const ctx: AppCtx = {
    platform, views, api, baseUrl, saveManager, replayStore, featureFlags, state, nav,
    getNetSession, applyGatewayUrl, playerName, avatarId, gateConsent, resolvePvpDeck, keepReplay, resolveWorldShard,
  };

  Object.assign(
    nav,
    createAuthNav(ctx),
    createLobbyNav(ctx),
    createRoomNav(ctx),
    createSocialNav(ctx),
    createWorldNav(ctx),
    createShopNav(ctx),
    createGameNav(ctx),
    createResultNav(ctx),
  );

  function start(): void {
    // Replay share deep-link landing (REPLAY_SHARE_DESIGN §4.1): if the launch parameters contain a share code → skip intro/login and go directly to the mute player.
    const shareCode = platform.getLaunchShareCode();
    if (shareCode && api) {
      void nav.goStatePlayer(shareCode);
      return;
    }
    if (saveManager.getFlag(SEEN_INTRO_FLAG)) {
      gateConsent(() => void nav.resolveEntry());
    } else {
      nav.goIntro();
    }
  }

  function onResized(): void {
    if (state.inLobby) nav.goLobby({ fromResize: true });
  }

  return { start, onResized };
}
