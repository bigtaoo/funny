// Analytics SDK public API (A9-4).
// Usage:
//   await analytics.init(platform, saveManager, apiBaseUrl);
//   analytics.track('screen_view', { scene: 'LobbyScene' });
//   analytics.track('game_end', { mode: 'campaign', result: 'win', ... });

import type { IPlatform } from '../platform/IPlatform';
import type { ApiClient } from '../net/ApiClient';
import { getOrCreateDeviceId } from '../platform/uuid';
import { onAppLifecycleChange } from '../platform/appLifecycle';
import { getLocale } from '../i18n';
import { fetchAnalyticsConfig, pingDeclinedLaunch, shouldTrack } from './config';
import { EventQueue, type AnalyticsEvent, type BatchMeta } from './queue';
import { telemetrySessionId } from './session';

// NOTE: `bootTimeline.ts` and `idleWatch.ts` are NOT re-exported here, deliberately. Both import
// `track` from this file, so re-exporting them would close an import cycle for the sake of a shorter
// call site; app.ts imports those two modules directly instead.

// Derive analytics base URL from API base. If API is https://host/api,
// analytics is at https://host/analytics (Caddy routes /analytics* to analyticsvc).
// Returns null when no API base is configured (offline).
function analyticsBaseUrl(apiBase: string): string {
  return apiBase.replace(/\/api$/, '');
}

let queue: EventQueue | null = null;
let sessionId: string | null = null;
let getToken: () => string | undefined = () => undefined;
let sessionStartTs = 0;
let scenesVisited: string[] = [];

/**
 * Scene/page-level funnel gate (A9-9, ANALYTICS_DESIGN). The core new-user path — login → intro/
 * tutorial gate → lobby → pick a level → prep → battle. screen_view itself is only 5%-sampled (see
 * analyticsvc DEFAULT_CONFIG), too noisy for a reliable per-scene funnel, so track() additionally fires
 * a 100%-sampled `nav_checkpoint` for exactly these scenes. Must match analyticsvc's SCENE_FUNNEL_SCENES.
 */
const NAV_CHECKPOINT_SCENES = new Set(['LoginScene', 'IntroScene', 'LobbyScene', 'CampaignMapScene', 'LevelPrepScene', 'GameScene']);

/**
 * GDPR consent gate (C5-c, L1-1). Default `false`: NO telemetry leaves the device
 * until the player accepts the consent dialog. The core calls {@link setConsent}
 * with the persisted flag before init (returning consented users), and again on
 * accept (fresh users).
 */
let consentGranted = false;

/**
 * State for the refusal tick (ANALYTICS_DESIGN §3.6c, {@link countDeclinedLaunch}): the analytics
 * base URL once {@link init} has derived it, and whether this launch's tick has been sent.
 *
 * Kept here rather than at the call site because the consent gate runs on every entry path (launch
 * and again after login) while the tick has to be exactly one per launch — the number it is compared
 * against counts launches.
 */
let bootCounterBase: string | null = null;
let declinedLaunchSent = false;

/**
 * Record that this launch is one a player who refused analytics made (§3.6c), by bumping the
 * unauthenticated launch counter's second column — see `config.ts` `pingDeclinedLaunch` for what is
 * and is not sent. Call it from the consent gate on both refusal paths: the launch the player
 * refuses on, and every later launch of theirs, which is what makes the counter comparable with the
 * launch count it is subtracted from.
 *
 * At most once per launch, and a no-op until {@link init} has a base URL — which it has before any
 * gate runs (createAppCore starts the SDK while it is being constructed, the gates run inside
 * `start()`), and never gets while offline, where there is no counter to write to in the first place.
 */
export function countDeclinedLaunch(): void {
  if (declinedLaunchSent || !bootCounterBase) return;
  declinedLaunchSent = true;
  pingDeclinedLaunch(bootCounterBase, getPlatformName());
}

/**
 * Events tracked before the SDK could send them — because consent had not been granted yet, or
 * because {@link init} had not run yet. **Nothing here has left the device**: the buffer is
 * memory-only, is replayed by {@link flushPreConsent} once both are true, and is dropped outright if
 * consent never comes. That is the same privacy position as the old "no-op until consent" behaviour,
 * but it keeps the events a funnel is actually built on.
 *
 * Why the consent half exists: a brand-new player's boot order is `goIntro() → age gate → consent
 * dialog` (app/createAppCore.ts `start()`), so *every* pre-lobby event — `session_start`, the
 * IntroScene `screen_view`/`nav_checkpoint`, and `intro_complete`/`intro_skip` — was tracked while the
 * gate was still closed and silently discarded. Only `session_start` was re-emitted on accept. The
 * result was structural, not statistical: the `intro_seen` step of the onboarding funnel
 * (ANALYTICS_DESIGN §9.6) counted zero for **every** new user, which is exactly the cohort that funnel
 * exists to measure, and because `computeStepFunnel` divides by the previous step, the step after it
 * lost its rate too.
 *
 * Why the pre-init half exists (2026-09-20): boot instrumentation (`bootTimeline.ts`) reports on the
 * window *before* `init()` by definition — the bundle download, the renderer, the L0 asset gate — and
 * `init()` is only reachable once `createAppCore` is being constructed, i.e. after all of it. The old
 * gate discarded those events twice over: a returning player has `setConsent(true)` applied one line
 * *before* `init()` (createAppCore.ts), so `consentGranted` was already true and the queue was still
 * null, which fell through to a plain `return`.
 */
let pending: AnalyticsEvent[] = [];
/** Buffer cap. Keeps the *earliest* events (the funnel head) and drops the tail once full. */
const PENDING_MAX = 100;

/**
 * Grant / revoke analytics consent (L1-1). Granting releases the pre-consent buffer (see
 * {@link pending}); revoking — or simply never granting — discards it.
 */
export function setConsent(granted: boolean): void {
  const was = consentGranted;
  consentGranted = granted;
  if (!granted) { pending = []; return; }
  if (!was) flushPreConsent();
}

/**
 * Release the pre-consent buffer into the real queue, applying each event's own sampling rate at
 * replay time. No-op until consent *and* init are both done: whichever finishes last calls this, so
 * the two can arrive in either order (returning players consent before init, fresh players after).
 */
function flushPreConsent(): void {
  if (!consentGranted || !queue || !sessionId) return;
  const buffered = pending;
  pending = [];
  for (const e of buffered) {
    if (shouldTrack(e.event)) queue.push(e);
  }
}

/**
 * The scene the player is on right now, as `screen_view` last reported it. Attached to every event
 * that describes *where* something happened (a click, a churn signal) rather than what it was.
 */
export function currentScene(): string {
  return scenesVisited[scenesVisited.length - 1] ?? 'unknown';
}

/**
 * Call once at app startup.  Fetches the server-side sampling config and
 * starts the 30-second flush timer + lifecycle hooks (see platform/appLifecycle.ts).
 *
 * @param platform   IPlatform (for deviceId, storage, platform name, OS, language)
 * @param api        ApiClient (for JWT token when user is logged in) — undefined for anonymous
 * @param apiBase    REST API base URL (e.g. https://host/api) — null → analytics disabled
 */
export async function init(
  platform: IPlatform,
  api: ApiClient | undefined,
  apiBase: string | null,
): Promise<void> {
  // A fresh init is a fresh launch, and the refusal tick is per launch — so the guard starts over
  // here rather than living for the lifetime of the module.
  bootCounterBase = null;
  declinedLaunchSent = false;

  if (!apiBase) return; // no server → analytics disabled silently

  const base = analyticsBaseUrl(apiBase);
  // Set before the first await below: the consent gate can reach the refusal path while the config
  // fetch is still in flight, and a tick that finds no base URL is simply not sent.
  bootCounterBase = base;

  sessionId = telemetrySessionId();
  sessionStartTs = Date.now();
  scenesVisited = [];

  const deviceId = getOrCreateDeviceId(platform.storage);
  const os = getPlatformOs(platform);
  const platformName = getPlatformName();
  const gameVersion = getGameVersion();

  getToken = () => api?.getToken() ?? undefined;

  const deviceFields = getDeviceFields();

  const getBatchMeta = (): BatchMeta => ({
    session_id: sessionId!,
    device_id: deviceId,
    platform: platformName,
    os,
    game_version: gameVersion,
    locale: getLocale(),
    // track() only ever queues events after consentGranted is true (see below), so every
    // batch that reaches the queue is post-consent by construction.
    consent: consentGranted,
    ...deviceFields,
  });

  queue = new EventQueue({ analyticsBaseUrl: base, getToken, getBatchMeta });

  // Fetch sampling config; on failure the disabled fallback is already in place. The platform rides
  // along as `?p=` for the server-side launch counter — see fetchAnalyticsConfig.
  await fetchAnalyticsConfig(base, platformName);

  queue.start();
  bindSessionLifecycle();

  // Release anything tracked before this point FIRST, so the queue stays in chronological order:
  // for a returning player (consent granted on the line above init, see createAppCore) the buffer
  // already holds the boot timeline's `boot` and app.ts's `prev_session_crash`, all of which happened
  // before the session they belong to was even given an id. Ordering costs nothing to preserve —
  // every event carries its own `ts` — but a batch that reads session_start-then-boot invites the
  // reader to doubt one of the two timestamps.
  flushPreConsent();
  // Emit session_start (sample=1.0 by default). Before consent it lands in the pre-consent buffer
  // like every other event and is replayed on accept.
  track('session_start', { platform: platformName, os, locale: getLocale() });
}

// ── Session lifecycle → churn_signal + session_end ───────────────────────────
// The queue owns flushSync on hide/unload; here we emit the *semantic* end
// markers (churn_signal + session_end) so the funnel can see where players drop.
// Re-armed on return to foreground so a tab-switch round-trip only logs once.
let lifecycleBound = false;
let hiddenFired = false;

function onAppHidden(reason: string): void {
  if (hiddenFired) return;
  hiddenFired = true;
  track('churn_signal', { reason, scene: currentScene() });
  endSession();
}

function bindSessionLifecycle(): void {
  if (lifecycleBound) return;
  lifecycleBound = true;
  onAppLifecycleChange((state) => {
    if (state === 'visible') { hiddenFired = false; return; } // back to foreground → re-arm
    onAppHidden(state === 'exit' ? 'explicit_exit' : 'background');
  });
}

/**
 * Track a UI control click (button/tab/icon). `id` is a stable, human-readable control id
 * (e.g. 'lobby.pvp', 'intro.start'); the current scene is attached automatically so first-day
 * behaviour can be analysed per scene. Fine-grained companion to `screen_view` — captures taps
 * that don't navigate, and the exact control identity within a scene.
 */
export function click(id: string, extra: Record<string, unknown> = {}): void {
  track('ui_click', { id, scene: currentScene(), ...extra });
}

/** Track a named event with arbitrary props (synchronous, non-blocking). */
export function track(event: string, props: Record<string, unknown> = {}): void {
  // screen_view bookkeeping + the nav_checkpoint companion event run ahead of every gate below.
  // Ahead of the consent gate so `scenes_visited` and the scene funnel still see the pre-consent
  // part of the session (those events are buffered, not discarded), and ahead of the
  // shouldTrack(event) check because nav_checkpoint has its own 100%-sample config entry (see
  // analyticsvc service/defs.ts DEFAULT_CONFIG) and must not inherit screen_view's 5% sampling
  // outcome, or it only ever fires on the ~5% of screen_view calls that already passed that check.
  if (event === 'screen_view') {
    const scene = props['scene'] as string | undefined;
    if (scene) scenesVisited.push(scene);
    queue?.checkpoint(); // flush before adding new screen event
    if (scene && NAV_CHECKPOINT_SCENES.has(scene)) {
      track('nav_checkpoint', { scene });
    }
  }

  // GDPR gate (L1-1) + the not-yet-initialised window: before consent nothing may leave the device,
  // and before init() there is nothing to leave through. Either way the event is held in memory so a
  // later accept still yields a complete session — including the part of it that predates the SDK.
  // See `pending`.
  if (!consentGranted || !queue || !sessionId) {
    if (pending.length < PENDING_MAX) pending.push({ event, ts: Date.now(), props });
    return;
  }

  if (!shouldTrack(event)) return;
  queue.push({ event, ts: Date.now(), props });
}

/** Emit session_end and flush. Call on app hide / explicit exit. */
export function endSession(): void {
  if (!queue || !sessionId) return;
  const durationSec = Math.round((Date.now() - sessionStartTs) / 1000);
  track('session_end', { duration_sec: durationSec, scenes_visited: scenesVisited });
  queue.flushSync();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getPlatformName(): 'web' | 'wechat' | 'crazygames' {
  const t = (globalThis as { TARGET?: string }).TARGET ?? '';
  if (t === 'wechat') return 'wechat';
  if (t === 'crazygames') return 'crazygames';
  return 'web';
}

function getPlatformOs(_platform: IPlatform): string {
  // WeChat: wx.getSystemInfoSync().system; Web: navigator.platform (deprecated but still widespread).
  const wx = (globalThis as unknown as { wx?: { getSystemInfoSync?: () => { system: string } } }).wx;
  if (wx?.getSystemInfoSync) {
    try { return wx.getSystemInfoSync().system; } catch { /* */ }
  }
  if (typeof navigator !== 'undefined') {
    return (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
      ?? navigator.platform
      ?? 'unknown';
  }
  return 'unknown';
}

function getGameVersion(): string {
  return (globalThis as { __NW_BUILD_VERSION__?: string }).__NW_BUILD_VERSION__ ?? '0.0.0';
}

/**
 * Real device fields for the ops device/browser dashboard (A9-9). Web: full `navigator.userAgent` +
 * screen size/DPR (server derives browser/device_type from the UA — never trust a client-supplied
 * browser name). WeChat: `wx.getSystemInfoSync()` already reports screen size/pixelRatio; no UA string
 * exists there, so `ua` is left unset and the server buckets it as platform=wechat instead.
 */
function getDeviceFields(): { ua?: string; screen_w?: number; screen_h?: number; dpr?: number } {
  const wx = (globalThis as unknown as {
    wx?: { getSystemInfoSync?: () => { screenWidth?: number; screenHeight?: number; pixelRatio?: number } };
  }).wx;
  if (wx?.getSystemInfoSync) {
    try {
      const info = wx.getSystemInfoSync();
      return { screen_w: info.screenWidth, screen_h: info.screenHeight, dpr: info.pixelRatio };
    } catch { /* fall through to web path below */ }
  }
  if (typeof navigator !== 'undefined' && typeof window !== 'undefined') {
    return {
      ua: navigator.userAgent,
      screen_w: window.screen?.width,
      screen_h: window.screen?.height,
      dpr: window.devicePixelRatio,
    };
  }
  return {};
}
