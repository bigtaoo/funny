// Analytics SDK public API (A9-4).
// Usage:
//   await analytics.init(platform, saveManager, apiBaseUrl);
//   analytics.track('screen_view', { scene: 'LobbyScene' });
//   analytics.track('game_end', { mode: 'campaign', result: 'win', ... });

import type { IPlatform } from '../platform/IPlatform';
import type { ApiClient } from '../net/ApiClient';
import { getOrCreateDeviceId } from '../platform/uuid';
import { getLocale } from '../i18n';
import { fetchAnalyticsConfig, shouldTrack } from './config';
import { EventQueue, type BatchMeta } from './queue';

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
 * accept (fresh users). `track()` is a no-op while this is false.
 */
let consentGranted = false;
/** session_start props captured at init, re-emitted by setConsent when consent flips on post-init. */
let sessionStartProps: Record<string, unknown> | null = null;

/**
 * Grant / revoke analytics consent (L1-1). When flipped on after init has already
 * run (fresh user just accepted), re-emits the session_start that was gated out so
 * the funnel still has a session anchor.
 */
export function setConsent(granted: boolean): void {
  const was = consentGranted;
  consentGranted = granted;
  if (granted && !was && queue && sessionId && sessionStartProps) {
    track('session_start', sessionStartProps);
  }
}

function genSessionId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Call once at app startup.  Fetches the server-side sampling config and
 * starts the 30-second flush timer + lifecycle hooks (beforeunload / wx.onHide).
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
  if (!apiBase) return; // no server → analytics disabled silently

  const base = analyticsBaseUrl(apiBase);
  sessionId = genSessionId();
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
    ...deviceFields,
  });

  queue = new EventQueue({ analyticsBaseUrl: base, getToken, getBatchMeta });

  // Fetch sampling config; on failure the disabled fallback is already in place.
  await fetchAnalyticsConfig(base);

  queue.start();
  bindSessionLifecycle();

  // Emit session_start immediately (sample=1.0 by default). Gated by consent —
  // if the player hasn't accepted yet this is a no-op and setConsent re-emits it.
  sessionStartProps = { platform: platformName, os, locale: getLocale() };
  track('session_start', sessionStartProps);
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
  track('churn_signal', { reason, scene: scenesVisited[scenesVisited.length - 1] ?? 'unknown' });
  endSession();
}

function bindSessionLifecycle(): void {
  if (lifecycleBound) return;
  lifecycleBound = true;
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') onAppHidden('background');
      else hiddenFired = false; // back to foreground → re-arm
    });
    window.addEventListener('beforeunload', () => onAppHidden('explicit_exit'));
  }
  const wx = (globalThis as { wx?: { onHide?: (cb: () => void) => void; onShow?: (cb: () => void) => void } }).wx;
  if (wx?.onHide) wx.onHide(() => onAppHidden('background'));
  if (wx?.onShow) wx.onShow(() => { hiddenFired = false; });
}

/**
 * Track a UI control click (button/tab/icon). `id` is a stable, human-readable control id
 * (e.g. 'lobby.pvp', 'intro.start'); the current scene is attached automatically so first-day
 * behaviour can be analysed per scene. Fine-grained companion to `screen_view` — captures taps
 * that don't navigate, and the exact control identity within a scene.
 */
export function click(id: string, extra: Record<string, unknown> = {}): void {
  track('ui_click', { id, scene: scenesVisited[scenesVisited.length - 1] ?? 'unknown', ...extra });
}

/** Track a named event with arbitrary props (synchronous, non-blocking). */
export function track(event: string, props: Record<string, unknown> = {}): void {
  if (!consentGranted) return; // GDPR gate (L1-1): no telemetry before consent
  if (!queue || !sessionId) return;
  if (!shouldTrack(event)) return;

  if (event === 'screen_view') {
    const scene = props['scene'] as string | undefined;
    if (scene) scenesVisited.push(scene);
    queue.checkpoint(); // flush before adding new screen event
    // Fully-sampled companion event for the scene-level funnel (A9-9) — screen_view itself is
    // 5%-sampled and too noisy to drive a reliable per-scene funnel.
    if (scene && NAV_CHECKPOINT_SCENES.has(scene)) {
      track('nav_checkpoint', { scene });
    }
  }

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

function getPlatformOs(platform: IPlatform): string {
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
