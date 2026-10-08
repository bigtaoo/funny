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
import { needsConsentChoice } from '../platform/consentRegion';
import type { AppViews } from './AppViews';
import type { EntryNoticeHost } from '../ui/dialogs/EntryNoticeStrip';
import type { Replay } from '../game';
import { initI18n, t } from '../i18n';
import { LocalSaveStore, SaveManager, ReplayStore } from '../game/meta';
import { ApiClient } from '../net/ApiClient';
import { getApiBaseUrl, getGatewayWsUrl, persistGatewayWsUrl } from '../net/config';
import { NetSession } from '../net/NetSession';
import { FeatureFlags } from '../net/featureFlags';
import { showToastMessage } from '../net/log';
import { WorldApiClient } from '../net/WorldApiClient';
import { defaultPvpDeck, validatePvpDeckClient } from '../game/meta/pvpLoadout';
import * as analytics from '../analytics';
import { installModerationBackend, syncBlockedForSession } from './blockedSync';
import {
  clientPlatformName,
  GDPR_CONSENT_FLAG, TERMS_ACCEPTED_FLAG, AGE_DECLARED_FLAG, MIN_AGE_YEARS, TOKEN_KEY, PLAYER_NAME_KEY, PLAYER_PUBLIC_ID_KEY,
  PLAYER_AVATAR_KEY, FALLBACK_SEASON, FREE_RENAME_KEY, PLATFORM_AVATAR_KEY, NAME_LOCKED_KEY,
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
  /** Submit an appeal against the account's active mute/temp-ban/ban (CONTENT_MODERATION_DESIGN.md §5.3).
   *  Undefined when offline (no API base URL configured) — the shell's appeal-prompt sink no-ops in that case. */
  submitAppeal?: (reason: string) => Promise<void>;
  /** Submit free-text player feedback (UI_DESIGN.md §4.1.1 lobby entry, SERVER_API.md §2.13).
   *  Undefined when offline, same as submitAppeal above. */
  submitFeedback?: (text: string) => Promise<void>;
  /**
   * The held token is unusable → toast, full logout, back to the login screen (nav/auth.ts's
   * forceLogout, ACCOUNT_DESIGN §5). Registered by the shell as net/log.ts's session-expired sink.
   * Always defined: it gates itself internally (offline mode / no persisted token / already
   * handling one), so the shell does not need to know whether an API base was configured.
   */
  forceLogout: () => void;
}

export function createAppCore(platform: IPlatform, views: AppViews): AppCore {
  // i18n must be ready before any scene builds its texts / playerName() runs.
  initI18n(platform.getLanguage(), platform.storage, platform.supportedLocales);

  // ── SaveManager: local-first save + optional cloud sync ─────────────────────
  const baseUrl = getApiBaseUrl(platform.storage);
  const api = baseUrl ? new ApiClient(baseUrl) : undefined;
  // Sliding token renewal (ACCOUNT_DESIGN §5): ApiClient swaps the renewed token into its own
  // in-memory field, but `nw_token` has exactly one owner — this layer (doAuth writes it on login,
  // doLogout removes it) — so persisting it is wired from here rather than from the transport.
  //
  // Only ever *overwrites* an existing entry, never creates one: an anonymous device/WeChat session
  // holds a token in memory only (NetSession.freshToken's api.auth path), and writing it to
  // TOKEN_KEY would silently promote that guest into a "logged-in" account everywhere the app tests
  // for the key — resolveEntry would stop offering the login screen, and Settings would start
  // offering Logout / rename / delete-account for an account nobody ever signed into.
  api?.setTokenRenewedHandler((token) => {
    if (platform.storage.getItem(TOKEN_KEY)) platform.storage.setItem(TOKEN_KEY, token);
  });
  const replayStore = new ReplayStore(platform.storage);
  // Report / block / blocked list (App Review 1.2, ui/moderation.ts) — offered only with an API.
  installModerationBackend(api, platform.storage);

  // Mutable session-lifetime state, shared by reference with every nav module.
  const state: AppState = {
    inLobby: false,
    offlineMode: false,
    gatewayUrl: getGatewayWsUrl(platform.storage),
    netSession: null,
    firstLobbyHandled: false,
    socialBadgeTotal: 0,
    mailBadgeCount: 0,
    achievementClaimable: false,
    shopCardClaimable: false,
    achievementReached: null,
    pendingRoomIntent: platform.rooms?.launchIntent() ?? null,
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
    onProfile: ({ displayName, publicId, gatewayUrl: gw, freeRename, nameLocked, platformAvatarId }) => {
      applyGatewayUrl(gw);
      // Cache the server-authoritative free-rename entitlement so the settings screen can render it offline.
      if (freeRename !== undefined) platform.storage.setItem(FREE_RENAME_KEY, freeRename ? '1' : '0');
      // Portal-imposed profile: every GET /save states it in full, so absence clears it.
      const avatarChanged = (platform.storage.getItem(PLATFORM_AVATAR_KEY) ?? undefined) !== platformAvatarId;
      if (platformAvatarId) platform.storage.setItem(PLATFORM_AVATAR_KEY, platformAvatarId);
      else platform.storage.removeItem(PLATFORM_AVATAR_KEY);
      if (nameLocked) platform.storage.setItem(NAME_LOCKED_KEY, '1');
      else platform.storage.removeItem(NAME_LOCKED_KEY);
      if (avatarChanged && state.inLobby) nav.goLobby();
      if (publicId) {
        platform.storage.setItem(PLAYER_PUBLIC_ID_KEY, publicId);
        syncBlockedForSession(api, platform.storage); // blocked list for this account (ui/moderation.ts)
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
  // `=== true` is what makes both non-consenting states safe here: "never asked" and
  // "chose essentials only" (flag `false`) look identical to init, which is correct —
  // neither may emit. gateGdpr re-applies the real value once it can tell them apart.
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
    // Duel invites ("切磋") must reach the player regardless of which scene they're currently on —
    // unlike `handlers` above, `globalHandlers` is never reassigned by scene code, so this stays
    // bound for the lifetime of the session (P0-8, comm-audit-2026-07-27 finding B9).
    state.netSession.globalHandlers.onDuelInvited = (d) => {
      showToastMessage(t('friends.duel.invitedToast', { name: d.fromName }), 'success');
    };
    return state.netSession;
  }

  /** Adopt the server-provided gateway WS address (from auth/save). */
  function applyGatewayUrl(url?: string): void {
    if (!url || url === state.gatewayUrl) return;
    state.gatewayUrl = url;
    persistGatewayWsUrl(platform.storage, url);
    if (state.netSession) { state.netSession.close(); state.netSession = null; }
    if (state.inLobby) nav.goLobby();
  }

  /** Display name for the profile chip: persisted name, else a generic guest label. */
  function playerName(): string {
    return platform.storage.getItem(PLAYER_NAME_KEY) || t('settings.guest');
  }

  /**
   * Selected avatar token, or undefined for letter-initial fallback. Prefers the server-synced
   * `save.equipped.avatar` (so a login on a new device picks up the same avatar other players see);
   * falls back to the local-only key from before avatar sync existed / offline mode.
   */
  function avatarId(): string | undefined {
    // A portal picture outranks the in-game pick, exactly as other players see it (server effectiveAvatarId).
    return platform.storage.getItem(PLATFORM_AVATAR_KEY)
      || saveManager.get().equipped['avatar'] || platform.storage.getItem(PLAYER_AVATAR_KEY) || undefined;
  }

  /**
   * The two first-launch gates. Every entry path goes through here (`resolveEntry` on launch and
   * after login), so this is the one place that decides what a player has to answer before reaching
   * a screen of their own.
   *
   * Both gates run through one {@link EntryGateDialog} mount (RETENTION_LAUNCH_PLAN.md §3.1: age
   * gate + consent wall merged into one screen) whenever more than one is still unanswered — the
   * common brand-new-player case. A returning player missing only one of the two still sees just
   * that one, rendered with the exact copy/layout the old standalone dialogs used (EntryGateDialog's
   * class doc). The permanent underage 'blocked' dead end is unaffected either way — it is still its
   * own {@link showAgeGate} mount, reached the instant the account is known to be blocked so nothing
   * about that state (not even the consent screen) ever has a chance to render first.
   *
   * Age is neutral (COMPLIANCE_GLOBAL §3.4, `privacy-policy §9`) and gates in front of consent so
   * nothing — not even the consent screen's own analytics event — happens before it is known. Both
   * flags are read off `save.flags` directly rather than `saveManager.getFlag` (which answers
   * `flags[key] === true`): "never asked" has to be distinguishable from "declared younger" /
   * "essentials only", or a player who already answered would be asked again every launch.
   *
   * | `flags.gdprConsent` | meaning | analytics |
   * |---|---|---|
   * | `true` | accepted everything | on |
   * | `false` | terms accepted, analytics refused ("essentials only") | off |
   * | absent | never asked | (gate shows) |
   *
   * Nothing is tracked on the GDPR refusal path — not even a `gdpr_consent { granted: false }`
   * event. The refusal is the one answer that cannot be reported through the thing it refuses; it
   * reaches the server as account state via `recordGdprConsent`, which is record-keeping under
   * Art 7(1), not telemetry. `countDeclinedLaunch()` is the one exception, and it is not telemetry
   * either: it bumps a date/platform/count row on the unauthenticated launch counter, which stores
   * nobody. Both refusal paths call it — the launch they refuse on and every launch after — because
   * since refusal stopped ending the session (ANALYTICS_DESIGN §3.6c) these players go on playing
   * and reporting nothing, and the launch funnel could not tell them apart from the ones who read
   * this dialog and left. That re-apply also has to happen on every launch even when the gate screen
   * itself does not show (age still pending, say) — the `answered !== undefined` branch below runs
   * unconditionally for exactly that reason, same as the old `gateGdpr` did.
   */
  function gateConsent(next: () => void): void {
    const declaredAge = saveManager.get().flags[AGE_DECLARED_FLAG];
    if (declaredAge === false) { views.showAgeGate('blocked', { onDeclared() { /* dead end */ } }); return; }

    const answeredGdpr = saveManager.get().flags[GDPR_CONSENT_FLAG];
    if (answeredGdpr !== undefined) {
      analytics.setConsent(answeredGdpr === true);
      if (answeredGdpr === false) analytics.countDeclinedLaunch();
    }

    // No entry screen at all on a notice-only build (IPlatform.entryNoticeOnly — CrazyGames,
    // COMPLIANCE_GLOBAL §3.3): straight into the game. No age question either: the portal itself is
    // 13+, the same minimum we declare (MIN_AGE_YEARS), and an account already recorded as underage
    // was stopped above. Terms/Privacy become a notice and the analytics question a non-blocking
    // prompt, both on the first lobby arrival (offerEntryNotice) — never over the tutorial battle.
    // Outside the EEA (needsConsentChoice) analytics are on by default with an opt-out, but only
    // from the moment the player has been *told*: until the analytics notice has been on screen —
    // the graduation card's small print, or the lobby strip for a player who skipped — events wait
    // in the pre-consent buffer and nothing leaves the device (statsNoticePending). Inside the EEA
    // they wait for the prompt's answer. Either way countAnonymousFunnelStep() counts the first
    // minute meanwhile.
    if (platform.entryNoticeOnly) {
      next();
      return;
    }

    const needAge = declaredAge !== true;
    const needConsent = answeredGdpr === undefined;
    // The current Terms of Use (EULA) — see TERMS_ACCEPTED_FLAG. A player who answered consent under
    // an older text is asked for the terms alone ('terms' mode); their analytics answer is kept.
    const needTerms = saveManager.get().flags[TERMS_ACCEPTED_FLAG] !== true;
    if (!needAge && !needConsent && !needTerms) { next(); return; }

    // How long the gate was up before the accept (ONBOARDING_DESIGN §11.9) — `gdpr_consent.dwell_ms`.
    const shownAt = Date.now();
    views.showEntryGate(
      {
        age: needAge ? 'ask' : 'ok',
        consent: needConsent ? (needsConsentChoice() ? 'choice' : 'accept-only') : needTerms ? 'terms' : null,
      },
      {
        onAnswered({ birthYear, granted }) {
          if (birthYear !== undefined) {
            const oldEnough = new Date().getFullYear() - birthYear >= MIN_AGE_YEARS;
            saveManager.setFlag(AGE_DECLARED_FLAG, oldEnough);
            if (!oldEnough) { views.showAgeGate('blocked', { onDeclared() { /* dead end */ } }); return; }
          }
          // Either consent button (and the lone 'terms' Accept) accepts the Terms of Use; only a real
          // consent question records an analytics answer.
          if (granted !== undefined) {
            if (needConsent) recordConsent(granted, { mode: 'gate', dwellMs: Date.now() - shownAt });
            saveManager.setFlag(TERMS_ACCEPTED_FLAG, true);
          }
          next();
        },
      },
    );
  }

  /**
   * Shared tail of every granted/refused analytics answer — the entry gate, the notice-only
   * build's implicit accept, and its non-blocking prompt: persist locally, apply, mirror to the
   * account. `gdpr_consent` is tracked on the granted path only (see gateConsent's doc for why the
   * refusal reports nothing but the anonymous launch tick); `mode` says which surface produced it and
   * `dwell_ms` how long that surface was on screen before the accept (absent for 'notice', which
   * has no surface of its own).
   */
  function recordConsent(granted: boolean, how: { mode: 'gate' | 'notice' | 'prompt'; dwellMs?: number }): void {
    saveManager.setFlag(GDPR_CONSENT_FLAG, granted);
    analytics.setConsent(granted);
    if (granted) {
      analytics.track('gdpr_consent', {
        granted: true, mode: how.mode, ...(how.dwellMs !== undefined ? { dwell_ms: Math.max(0, Math.round(how.dwellMs)) } : {}),
      });
    } else {
      analytics.countDeclinedLaunch();
    }
    const token = platform.storage.getItem(TOKEN_KEY);
    if (api && token) { api.setToken(token); void api.recordGdprConsent(granted).catch(() => { /* best-effort; flag still syncs via SaveManager */ }); }
  }

  /**
   * Notice-only build (IPlatform.entryNoticeOnly), outside the EEA, analytics never answered: they are
   * on by default with an opt-out in Settings (COMPLIANCE_GLOBAL §3.3b), and wait in the pre-consent
   * buffer until the player has been shown the analytics notice. The screen that shows it calls
   * {@link acknowledgeStatsNotice}, which records the default as consent mode 'notice' and so
   * releases the buffer — the events of the first minute are kept, they just leave the device after
   * the notice rather than before it.
   */
  function statsNoticePending(): boolean {
    const flags = saveManager.get().flags;
    return platform.entryNoticeOnly === true && flags[GDPR_CONSENT_FLAG] === undefined
      && flags[AGE_DECLARED_FLAG] !== false && !needsConsentChoice();
  }

  function acknowledgeStatsNotice(): void {
    if (statsNoticePending()) recordConsent(true, { mode: 'notice' });
  }

  /**
   * The notice-only build's Terms/Privacy notice and analytics prompt (IPlatform.entryNoticeOnly,
   * COMPLIANCE_GLOBAL §3.3), put on `host` — the lobby today, any screen that implements
   * {@link EntryNoticeHost} later. A no-op everywhere else, and when there is nothing left to say:
   *
   *  * **terms** — shown until it has been shown once; being shown is what records
   *    TERMS_ACCEPTED_FLAG ("by playing you agree": the notice IS the acceptance on this build).
   *  * **stats** — the analytics notice ({@link statsNoticePending}): one more sentence, and being
   *    shown is the acknowledgement, like `terms`.
   *  * **consent** — only where `needsConsentChoice()` and the player has not answered yet. "Allow"
   *    / "No thanks" go through the same {@link recordConsent} as the gate. Leaving the screen is
   *    not an answer: the question comes back next launch, and Settings' toggle works meanwhile.
   *
   * Decided once per launch: a strip the player has not closed or answered yet is simply put back
   * every time the host is shown again (a resize rebuild, a profile refresh, coming back from another
   * screen) — like any non-blocking notice bar it stays until dealt with, but it never grows into a
   * second, different offer. Exposed on the ctx so other screens can offer it too (e.g. the campaign
   * map, once nothing else is drawn over it there).
   */
  let entryNoticeOffered = false;
  let entryNoticeOpen: { terms: boolean; stats: boolean; consent: boolean; shownAt: number } | null = null;
  function offerEntryNotice(host: EntryNoticeHost): void {
    if (!platform.entryNoticeOnly || !host.showEntryNotice) return;
    if (entryNoticeOpen) { mountEntryNotice(host, entryNoticeOpen); return; }
    if (entryNoticeOffered) return;
    const flags = saveManager.get().flags;
    if (flags[AGE_DECLARED_FLAG] === false) return;
    const terms = flags[TERMS_ACCEPTED_FLAG] !== true;
    const consent = flags[GDPR_CONSENT_FLAG] === undefined && needsConsentChoice();
    const stats = statsNoticePending();
    if (!terms && !consent && !stats) return;
    entryNoticeOffered = true;
    if (terms) saveManager.setFlag(TERMS_ACCEPTED_FLAG, true);
    entryNoticeOpen = { terms, stats, consent, shownAt: Date.now() };
    mountEntryNotice(host, entryNoticeOpen);
    if (stats) acknowledgeStatsNotice();
  }

  function mountEntryNotice(
    host: EntryNoticeHost, open: { terms: boolean; stats: boolean; consent: boolean; shownAt: number },
  ): void {
    host.showEntryNotice?.({
      terms: open.terms,
      stats: open.stats,
      consent: open.consent,
      onAnswer(granted) {
        entryNoticeOpen = null;
        // A Settings toggle in between may already have answered; the strip does not overwrite it.
        if (saveManager.get().flags[GDPR_CONSENT_FLAG] !== undefined) return;
        recordConsent(granted, { mode: 'prompt', ...(granted ? { dwellMs: Date.now() - open.shownAt } : {}) });
      },
      onClose() { entryNoticeOpen = null; },
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
    getNetSession, applyGatewayUrl, playerName, avatarId, gateConsent, offerEntryNotice, statsNoticePending, acknowledgeStatsNotice,
    resolvePvpDeck, keepReplay, resolveWorldShard,
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
    // Replay share deep-link landing (REPLAY_SHARE_DESIGN §4.1): if the launch parameters contain a share code → skip the entry gate/login and go directly to the mute player.
    const shareCode = platform.getLaunchShareCode();
    if (shareCode && api) {
      void nav.goStatePlayer(shareCode);
      return;
    }
    // Hand the persisted token to ApiClient before the gates run, not only later in resolveEntry
    // (2026-09-09 fix): the gates answer with saveManager.setFlag, and that only pushes to the server
    // while `online()` (i.e. a token is held). A returning player without this would answer the age
    // gate into a local-only write, which resolveEntry's own pull then overwrites with the cloud
    // `flags` — leaving the gate to ask again on every single launch. Setting the token this early is
    // safe: resolveEntry/doAuth still (re)apply the authoritative one for their own path.
    const storedToken = platform.storage.getItem(TOKEN_KEY);
    if (api && storedToken) api.setToken(storedToken);
    // No story before play, on any platform (ONBOARDING_DESIGN §11.7): the first screen is the
    // entry gate, then straight into the game. The story is told later and shorter — a one-shot card
    // the first time the campaign map opens (goCampaignMap) — and the full intro is replayable from
    // settings.
    gateConsent(() => void nav.resolveEntry());
  }

  function onResized(): void {
    if (state.inLobby) nav.goLobby({ fromResize: true });
  }

  return {
    start,
    onResized,
    submitAppeal: api ? (reason: string) => api.submitAppeal(reason) : undefined,
    submitFeedback: api ? (text: string) => api.submitFeedback(text) : undefined,
    forceLogout: () => nav.forceLogout(),
  };
}
