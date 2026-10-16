// Analytics SDK public API (A9-4).
// Usage:
//   await analytics.init(platform, saveManager, apiBaseUrl);
//   analytics.track('screen_view', { scene: 'LobbyScene' });
//   analytics.track('game_end', { mode: 'campaign', result: 'win', ... });

import type { IPlatform } from '../platform/IPlatform';
import type { ApiClient } from '../net/ApiClient';
import { getOrCreateDeviceId } from '../platform/uuid';
import { onAppLifecycleChange } from '../platform/appLifecycle';
import { getLocale, getPlatformLanguage } from '../i18n';
import { fetchAnalyticsConfig, pingAnonymousFunnelStep, pingDeclinedLaunch, shouldTrack } from './config';
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
 * The first-session steps {@link countAnonymousFunnelStep} accepts: the v2 tutorial sequence
 * (ONBOARDING_DESIGN §11.9), its Skip, the first attempt / first clear of the first three
 * campaign levels, the load checkpoints (`open_*` is sent by the CrazyGames HTML before the
 * bundle exists, `loaded_*` by {@link countLoadedLaunch}; ANALYTICS_DESIGN §3.6f), the ink-full
 * nudge and the first-session reward loop (gift → gacha → daily, ONBOARDING_DESIGN §14.2/§14.3), and
 * `return_launch` — a launch whose save had cleared ch1_lv1 before it started, the one retention
 * signal that also counts players who never consented ({@link countReturnLaunch}). Since 2026-10-14
 * (ONBOARDING_DESIGN §15): `alive_60s` — the launch is still open a minute after its first screen,
 * our side of CrazyGames' "gameplay conversion" ({@link countLoadedLaunch}) — the first card played in
 * ch1_lv1 and its idle-card hint, and the first attempt / clear of levels 4–5. Since 2026-10-16
 * (ONBOARDING_DESIGN §17.7): the tutorial free fight's idle prompt / resume / win, and per early level
 * `lvN_auto` (the chain banner's countdown started it, no tap) and `lvN_first_play` (first card played)
 * — chaining made `lvN_start` count players who were already leaving. Must match analyticsvc's `ANON_FUNNEL_STEPS` (service/defs.ts) and the `t` enum on
 * `GET /analytics/config`; the server drops anything else.
 */
export const ANONYMOUS_FUNNEL_STEPS = [
  'open_desktop', 'open_mobile', 'loaded_desktop', 'loaded_mobile', 'alive_60s',
  'tutorial_start', 'beat_unit', 'beat_building', 'beat_spell', 'graduate',
  'free_idle_prompt', 'free_idle_resume', 'free_won', 'tutorial_complete', 'tutorial_skip',
  'lv1_auto', 'lv1_start', 'lv1_first_play', 'lv1_play_hint', 'lv1_clear',
  'lv2_auto', 'lv2_start', 'lv2_first_play', 'lv2_clear', 'lv3_auto', 'lv3_start', 'lv3_first_play', 'lv3_clear',
  'lv4_auto', 'lv4_start', 'lv4_first_play', 'lv4_clear', 'lv5_auto', 'lv5_start', 'lv5_first_play', 'lv5_clear',
  'ink_full_hint', 'gift_shown', 'gift_gacha', 'gacha_pull', 'daily_shown', 'daily_open', 'daily_claim',
  'return_launch',
] as const;
export type AnonymousFunnelStep = (typeof ANONYMOUS_FUNNEL_STEPS)[number];

/** Steps already ticked this launch — see {@link countAnonymousFunnelStep}. */
let anonFunnelSent = new Set<string>();

/**
 * Tick the anonymous, aggregate first-session funnel counter (COMPLIANCE_GLOBAL §3.3b,
 * ANALYTICS_DESIGN §3.6d). Sends only the build target and `step` (`GET /analytics/config?p=…&t=…`):
 * no device id, no token, no session id, nothing stored on the device — the server keeps a (date,
 * platform, step) count and nothing else. Being neither personal data nor device access, it needs no
 * consent, so it counts **every** player whatever their analytics answer: it is the one funnel that
 * covers the EEA players who never said yes, and the one consented and unconsented players can be
 * compared on. Every tick also carries the build version and the input class (`c=m|d`, the same
 * `(pointer: coarse)` test as the `open_*` / `loaded_*` pair), so each step splits mobile vs desktop.
 *
 * Once per step per launch: a settings "replay tutorial", or a second try at a level in the same
 * launch, is not a second player reaching the step. (A level failed in two separate launches does
 * tick twice — the `lvN_start` row counts attempt-launches, read it against `lvN_clear`.) A no-op
 * offline (no base URL). Safe to call from anywhere, unconditionally.
 */
export function countAnonymousFunnelStep(step: AnonymousFunnelStep): void {
  if (!bootCounterBase) return;
  if (!(ANONYMOUS_FUNNEL_STEPS as readonly string[]).includes(step)) return; // JS callers / stale keys
  if (anonFunnelSent.has(step)) return;
  anonFunnelSent.add(step);
  pingAnonymousFunnelStep(bootCounterBase, getPlatformName(), step, getGameVersion(), isCoarsePointer() ? 'm' : 'd');
}

/** The input-class test shared by every anonymous tick; keep it identical to public/crazygames/index.html's. */
function isCoarsePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/** `alive_60s` fires this long after the first screen (ONBOARDING_DESIGN §15.1). */
export const ALIVE_TICK_MS = 60_000;

/**
 * Tick `return_launch` on the first lobby arrival of a launch when the save shows ch1_lv1 cleared and
 * this launch did not clear it — i.e. a player who came back. Reads only the save the game already
 * keeps (COMPLIANCE_GLOBAL §3.3b), so like every other step it needs no consent; per day and build
 * version it is a coarse retention trend that, unlike the consented D1, also covers the EEA players
 * who never said yes. A same-day second launch counts too: read it as "launches by returners".
 */
export function countReturnLaunch(cleared: readonly string[]): void {
  if (cleared.includes('ch1_lv1') && !anonFunnelSent.has('lv1_clear')) countAnonymousFunnelStep('return_launch');
}

/**
 * The second load checkpoint (ANALYTICS_DESIGN §3.6f): the first screen is up. Paired with the
 * `open_*` tick the CrazyGames HTML sends before the bundle downloads — the gap between the two is
 * the launches abandoned while loading, which no event can describe (nothing is sent before init).
 * The input-class test must stay identical to the one in public/crazygames/index.html, or the two
 * halves of each pair count different populations.
 *
 * It also arms `alive_60s`: a launch whose page is still open a minute later. CrazyGames grades
 * "gameplay conversion" as the share of players still playing after one minute; that number is
 * computed on their side with no breakdown, and this is the same cut taken on ours — split by device
 * and build, and readable against every other step. A closed tab never fires it.
 */
export function countLoadedLaunch(): void {
  countAnonymousFunnelStep(isCoarsePointer() ? 'loaded_mobile' : 'loaded_desktop');
  setTimeout(() => countAnonymousFunnelStep('alive_60s'), ALIVE_TICK_MS);
}

/**
 * Events tracked before the SDK could send them — because consent had not been granted yet, or
 * because {@link init} had not run yet. **Nothing here has left the device**: the buffer is
 * memory-only, is replayed by {@link flushPreConsent} once both are true, and is dropped outright if
 * consent never comes. That is the same privacy position as the old "no-op until consent" behaviour,
 * but it keeps the events a funnel is actually built on.
 *
 * Why the consent half exists: a brand-new player's boot order was `goIntro() → age gate → consent
 * dialog` (app/createAppCore.ts `start()`; the intro left the boot path in ONBOARDING_DESIGN §11.7,
 * the gate still comes before everything else), so *every* pre-lobby event — `session_start`, the
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
  anonFunnelSent = new Set();

  if (!apiBase) return; // no server → analytics disabled silently

  const base = analyticsBaseUrl(apiBase);
  // Set before the first await below: the consent gate can reach the refusal path while the config
  // fetch is still in flight, and a tick that finds no base URL is simply not sent.
  bootCounterBase = base;

  sessionId = telemetrySessionId();
  sessionStartTs = Date.now();
  scenesVisited = [];

  const deviceId = await getOrCreateDeviceId(platform.storage);
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

  const q = new EventQueue({ analyticsBaseUrl: base, getToken, getBatchMeta });

  // Fetch sampling config; on failure the disabled fallback is already in place. The platform rides
  // along as `?p=` for the server-side launch counter — see fetchAnalyticsConfig.
  await fetchAnalyticsConfig(base, platformName);

  // The queue is published only NOW, after the sampling config has arrived (2026-10-07 fix). Both
  // track() and flushPreConsent() read "queue is set" as "the SDK is ready" and then sample through
  // shouldTrack() — which, while the config request is still in flight, answers from the disabled
  // fallback and drops everything. With the queue assigned before the await, a consent granted
  // inside that window replayed the whole pre-consent buffer into shouldTrack() and lost it, and
  // every event tracked after it was lost too. That is the CrazyGames reviewer's session
  // (CRAZYGAMES_LAUNCH §7): the consent gate is the first screen there, a QA tester answers it in
  // about a second, and the session came out with `session_start` (tracked after the config landed)
  // but no `boot`/`first_frame`/`load_time` and no `gdpr_consent`, while the save — written through a
  // different path — said consent was true. Until this line every event stays in `pending`.
  queue = q;
  q.start();
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
  // `locale` is the UI language the game picked; `platform_locale` is what the platform asked for.
  track('session_start', { platform: platformName, os, locale: getLocale(), platform_locale: getPlatformLanguage() });
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
  track('churn_signal', { reason, scene: currentScene(), ...battleProps() });
  endSession();
}

// ── Battle probe → `battle` on mid-battle exits (ANALYTICS_DESIGN §5.6d) ─────
// The views layer points this at the live GameScene when a battle is mounted; the scene answers null
// once destroyed, so a probe left behind after the battle simply adds nothing.
let battleProbe: (() => object | null) | null = null;

export function setBattleProbe(probe: (() => object | null) | null): void {
  battleProbe = probe;
}

/**
 * `{ battle: {...} }` while a battle is on screen, `{}` otherwise — spread into the props of every event
 * that can mean "left in the middle of a fight" (churn_signal, level_abandon). Runs on the unload path,
 * so a probe that throws costs the snapshot, never the event.
 */
export function battleProps(): { battle?: object } {
  try {
    const b = battleProbe?.();
    return b ? { battle: b } : {};
  } catch {
    return {};
  }
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
