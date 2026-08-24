// anomaly.ts's device / viewport / orientation context, extracted as form① (claudedocs/client-modules.md
// "单文件 500 行收敛"). Imports nothing from its siblings, so it sits at the bottom of the anomaly
// module's dependency order (reporter.ts → this, never the reverse).
//
// WHY THIS EXISTS — the gap it closes:
// Until 2026-08-24 the anomaly channel's only "who reported this" field was `platform`, which is the
// **build target** (web | wechat | crazygames), not the device. A phone browser and a desktop browser
// both report platform=web, so a field report of "the page keeps dying on my phone" could not be
// confirmed, counted, or correlated from Loki at all — every crash line looked identical regardless of
// hardware. Worse for the case that prompted this: the client dies *while the screen is being rotated*,
// and nothing in the pipeline recorded orientation, so the one variable that mattered was invisible.
//
// Three field groups come out of here, all **inline logfmt** (never Loki labels — labels must stay
// low-cardinality, per clientLog.ts's ingestion convention):
//   · session-stable  device / dpr / mem     — attached once per upload batch
//   · moment-level    orient / vp            — captured at report() time, per event
//   · the smoking gun sinceRot               — ms between the last orientation flip and this event
//
// `sinceRot` is the field this module was really built for: if rotation-time crashes are real, their
// reports cluster at sinceRot≈0 while ordinary crashes carry no sinceRot at all. That is a
// distinguishable signature rather than a hunch, and it is queryable directly:
//   {source="client", kind="anomaly"} | logfmt | device="phone" | sinceRot < 2000

/** Coarse hardware bucket. Deliberately 4 values — this is inline logfmt on every anomaly line, and
 *  a free-form UA string there would be both high-cardinality and a privacy liability. */
export type DeviceClass = 'phone' | 'tablet' | 'desktop' | 'unknown';

export type OrientationName = 'portrait' | 'landscape';

/** Moment-level context, captured when an event is reported (not when the batch is flushed). */
export interface MomentContext {
  orient?: OrientationName;
  /** Viewport as `WxH` in CSS px — the box the game actually lays out against, not `screen.*`. */
  vp?: string;
  /** ms since the last orientation flip; absent when this session never rotated. */
  sinceRot?: number;
}

interface WxSystemInfo {
  screenWidth?: number; screenHeight?: number;
  windowWidth?: number; windowHeight?: number;
  pixelRatio?: number;
}

interface WxGlobal {
  getSystemInfoSync?: () => WxSystemInfo;
  onWindowResize?: (cb: (res: { windowWidth?: number; windowHeight?: number }) => void) => void;
}

function wxApi(): WxGlobal | undefined {
  return (globalThis as unknown as { wx?: WxGlobal }).wx;
}

function wxInfo(): WxSystemInfo | undefined {
  try { return wxApi()?.getSystemInfoSync?.(); } catch { return undefined; }
}

// ── session-stable fields ────────────────────────────────────────────────────

let cachedDevice: DeviceClass | undefined;

/**
 * Classify the device once per session.
 *
 * The UA is read but never *reported* — only this 4-value bucket leaves the client. Note the two
 * traps this deliberately handles, because getting either wrong silently mislabels a large slice of
 * real mobile traffic as "desktop" and hides exactly the population we are trying to see:
 *   · Android tablets send "Android" WITHOUT the "Mobile" token that Android phones carry, so
 *     "contains Android" ⇒ phone is wrong.
 *   · iPadOS 13+ defaults to desktop-class browsing and reports a **MacIntel** platform with a
 *     Macintosh UA — indistinguishable from a real Mac except that it reports touch points.
 */
export function deviceClass(): DeviceClass {
  if (cachedDevice) return cachedDevice;
  cachedDevice = classify();
  return cachedDevice;
}

function classify(): DeviceClass {
  // WeChat mini-game: no UA at all, but the runtime only exists on phones/tablets. Split on the
  // short edge in device-independent px — the same ~600px break Android itself uses for "large".
  const wi = wxInfo();
  if (wi) {
    const short = Math.min(wi.screenWidth ?? 0, wi.screenHeight ?? 0);
    if (!short) return 'unknown';
    return short >= 600 ? 'tablet' : 'phone';
  }

  const nav = (globalThis as { navigator?: { userAgent?: string; platform?: string; maxTouchPoints?: number } }).navigator;
  if (!nav || typeof nav.userAgent !== 'string') return 'unknown';
  const ua = nav.userAgent;

  if (/iPad/i.test(ua)) return 'tablet';
  // Desktop-mode iPad (see the doc comment): Macintosh UA + a touchscreen. Real Macs report 0.
  if (/Macintosh/i.test(ua) && (nav.maxTouchPoints ?? 0) > 1) return 'tablet';
  if (/iPhone|iPod/i.test(ua)) return 'phone';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'phone' : 'tablet';
  if (/Tablet|PlayBook|Silk/i.test(ua)) return 'tablet';
  // Generic catch-all last: "Mobi" is the spec-blessed token for a phone-sized browser.
  if (/Mobi/i.test(ua)) return 'phone';
  return 'desktop';
}

/** Physical pixels per CSS px. Rounded to 2dp — the raw value can carry a long fractional tail on
 *  Android, which would bloat the inline field for no diagnostic gain. */
export function devicePixelRatio(): number | undefined {
  const wi = wxInfo();
  if (wi?.pixelRatio) return round2(wi.pixelRatio);
  const dpr = (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
  return typeof dpr === 'number' && Number.isFinite(dpr) ? round2(dpr) : undefined;
}

/** Approximate device RAM in GB (Chromium-only, and already coarsened to a power of two by the
 *  browser). Absent elsewhere. Worth reporting because the failure this module chases is an
 *  out-of-memory kill: "only ever on 2GB-class hardware" is a very different bug from "everywhere". */
export function deviceMemoryGb(): number | undefined {
  const dm = (globalThis as { navigator?: { deviceMemory?: number } }).navigator?.deviceMemory;
  return typeof dm === 'number' && Number.isFinite(dm) && dm > 0 ? dm : undefined;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

// ── moment-level fields ──────────────────────────────────────────────────────

/** Viewport in CSS px. Prefers the *window* box over the *screen* box: the screen does not shrink
 *  when the on-screen keyboard or a browser chrome bar appears, but the game's layout does. */
function viewport(): { w: number; h: number } | undefined {
  const wi = wxInfo();
  if (wi) {
    const w = wi.windowWidth ?? wi.screenWidth;
    const h = wi.windowHeight ?? wi.screenHeight;
    return w && h ? { w, h } : undefined;
  }
  const g = globalThis as { innerWidth?: number; innerHeight?: number };
  return g.innerWidth && g.innerHeight ? { w: g.innerWidth, h: g.innerHeight } : undefined;
}

/**
 * Current orientation, derived from the viewport's aspect.
 *
 * Deliberately NOT imported from layout/ScalingManager's `detectOrientation`, which is the authority
 * for layout: that module pulls in PIXI (and transitively the engine), and this file has to stay
 * loadable on the bare crash-reporting path, in unit tests, and before the renderer exists. The rule
 * duplicated here is one comparison, and it is pinned to the layout module's by a test.
 */
export function orientation(): OrientationName | undefined {
  const vp = viewport();
  if (!vp) return undefined;
  return vp.w > vp.h ? 'landscape' : 'portrait';
}

// ── rotation tracking ────────────────────────────────────────────────────────

let lastRotAt: number | undefined;
let lastOrient: OrientationName | undefined;
let rotationWatchInstalled = false;

/** Epoch ms of the most recent orientation flip this session, or undefined if it never rotated. */
export function lastRotationAt(): number | undefined { return lastRotAt; }

/**
 * Start watching for orientation flips.
 *
 * Listens on three events because no single one is reliable across the field: `screen.orientation`'s
 * change event is the modern signal, `orientationchange` is the legacy iOS one, and `resize` is the
 * backstop that fires everywhere (including a desktop window being dragged into portrait). All three
 * funnel through the same check, and a flip is only recorded when the **derived orientation actually
 * changed** — so the multiple events one physical rotation fires collapse into one record, and the
 * many resizes that are not rotations (keyboard, chrome bars, window drags) are ignored.
 *
 * `onRotate` is how crashSentinel.ts persists the flip immediately instead of waiting for its 15s
 * heartbeat: a session that rotates and is then killed must leave the rotation on disk, or the very
 * crash this exists to catch reports as a bare `aliveMs:0` with no context.
 */
export function installRotationWatch(onRotate?: () => void): void {
  if (rotationWatchInstalled) return;
  rotationWatchInstalled = true;
  lastOrient = orientation();

  const check = (): void => {
    const now = orientation();
    if (!now || now === lastOrient) return;
    lastOrient = now;
    lastRotAt = Date.now();
    onRotate?.();
  };

  const wx = wxApi();
  if (wx?.onWindowResize) { try { wx.onWindowResize(() => check()); } catch { /* ignore */ } return; }

  const g = globalThis as typeof globalThis & {
    addEventListener?: (t: string, cb: () => void) => void;
    screen?: { orientation?: { addEventListener?: (t: string, cb: () => void) => void } };
  };
  try { g.screen?.orientation?.addEventListener?.('change', check); } catch { /* ignore */ }
  g.addEventListener?.('orientationchange', check);
  g.addEventListener?.('resize', check);
}

/** Snapshot the moment-level context for one event. Fields the runtime can't supply are omitted
 *  rather than sent empty, so a missing field reads as "unavailable here" and not as a real value. */
export function momentContext(): MomentContext {
  const ctx: MomentContext = {};
  const o = orientation();
  if (o) ctx.orient = o;
  const vp = viewport();
  if (vp) ctx.vp = `${Math.round(vp.w)}x${Math.round(vp.h)}`;
  if (lastRotAt !== undefined) ctx.sinceRot = Math.max(0, Date.now() - lastRotAt);
  return ctx;
}

/** Test seam: forget the cached device class and all rotation state. */
export function resetDeviceContextForTest(): void {
  cachedDevice = undefined;
  lastRotAt = undefined;
  lastOrient = undefined;
  rotationWatchInstalled = false;
}
