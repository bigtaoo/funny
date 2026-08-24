// Unit coverage for net/anomaly/deviceContext.ts — the device / orientation / rotation fields the
// anomaly channel started carrying on 2026-08-24.
//
// Worth testing at this level rather than only through the anomaly chain: every one of these fields
// exists to be *filtered on* in Grafana, and the failure mode is silent. A UA branch that mislabels
// phones as desktops does not throw, does not fail a build, and does not look wrong in a log line —
// it just quietly removes the population you were trying to count, and you find out weeks later when
// a query returns "no mobile crashes" for a bug that only happens on mobile.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  deviceClass, devicePixelRatio, deviceMemoryGb,
  orientation, momentContext, installRotationWatch, lastRotationAt,
  resetDeviceContextForTest,
} from '../src/net/anomaly/deviceContext';

/** Install a `navigator` with just the fields classify() reads. */
function stubNavigator(ua: string, extra: { maxTouchPoints?: number; deviceMemory?: number } = {}): void {
  vi.stubGlobal('navigator', { userAgent: ua, ...extra });
}

/** Install a viewport. Rotating = calling this again with the axes swapped. */
function stubViewport(w: number, h: number): void {
  vi.stubGlobal('innerWidth', w);
  vi.stubGlobal('innerHeight', h);
}

/** Capture globalThis event listeners so a test can fire them. */
function captureListeners(): (type: string) => void {
  const listeners = new Map<string, Array<() => void>>();
  vi.stubGlobal('addEventListener', (type: string, cb: () => void) => {
    const arr = listeners.get(type) ?? [];
    arr.push(cb);
    listeners.set(type, arr);
  });
  return (type) => (listeners.get(type) ?? []).forEach((f) => f());
}

beforeEach(() => resetDeviceContextForTest());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

// ── device classification ────────────────────────────────────────────────────
describe('deviceClass', () => {
  // Real UA strings. The iPhone one is the device from the 2026-08-22 crash loop that prompted all
  // of this — an in-app WebView (GSA = the Google app), which is exactly the memory-capped
  // environment `platform=web` alone could never single out.
  const UAS: Array<[string, string, ReturnType<typeof deviceClass>]> = [
    ['iPhone in the Google app WebView',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/419.4.905781065 Mobile/15E148 Safari/604.1', 'phone'],
    ['iPhone Safari',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'phone'],
    ['Android phone Chrome',
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36', 'phone'],
    ['iPad in legacy mode',
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'tablet'],
    ['desktop Chrome on Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36', 'desktop'],
  ];
  it.each(UAS)('%s → %s', (_label, ua, expected) => {
    stubNavigator(ua);
    expect(deviceClass()).toBe(expected);
  });

  // The two traps called out in classify()'s doc comment. Both are cases where the naive check is
  // wrong in the direction that HIDES mobile traffic, which is the direction that matters here.
  it('an Android tablet is a tablet — it omits the "Mobile" token that Android phones carry', () => {
    stubNavigator('Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
    expect(deviceClass()).toBe('tablet');
  });

  it('an iPad in desktop mode is a tablet, and a real Mac is still a desktop', () => {
    const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
    // iPadOS 13+ browses as desktop-class: same Macintosh UA, distinguishable only by touch points.
    stubNavigator(MAC_UA, { maxTouchPoints: 5 });
    expect(deviceClass()).toBe('tablet');

    resetDeviceContextForTest();
    stubNavigator(MAC_UA, { maxTouchPoints: 0 });
    expect(deviceClass()).toBe('desktop');
  });

  it('classifies WeChat mini-game by its short edge — there is no UA to read there', () => {
    vi.stubGlobal('wx', { getSystemInfoSync: () => ({ screenWidth: 390, screenHeight: 844, pixelRatio: 3 }) });
    expect(deviceClass()).toBe('phone');

    resetDeviceContextForTest();
    vi.stubGlobal('wx', { getSystemInfoSync: () => ({ screenWidth: 820, screenHeight: 1180, pixelRatio: 2 }) });
    expect(deviceClass()).toBe('tablet');
  });

  it('reports unknown rather than guessing when the runtime exposes no navigator', () => {
    vi.stubGlobal('navigator', undefined);
    expect(deviceClass()).toBe('unknown');
  });

  it('is computed once — the UA cannot change mid-session, and this runs on every report', () => {
    stubNavigator('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148');
    expect(deviceClass()).toBe('phone');
    stubNavigator('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/119.0.0.0');
    expect(deviceClass()).toBe('phone'); // cached
  });
});

describe('devicePixelRatio / deviceMemoryGb', () => {
  it('rounds dpr to 2dp — Android reports a long fractional tail that would bloat every line', () => {
    vi.stubGlobal('devicePixelRatio', 2.6250001);
    expect(devicePixelRatio()).toBe(2.63);
  });

  it('omits device memory where the API does not exist (everything but Chromium)', () => {
    stubNavigator('Mozilla/5.0 (iPhone) Mobile/15E148');
    expect(deviceMemoryGb()).toBeUndefined();
    stubNavigator('Mozilla/5.0 (Linux; Android 13; Pixel 7) Mobile', { deviceMemory: 4 });
    expect(deviceMemoryGb()).toBe(4);
  });
});

// ── orientation + viewport ───────────────────────────────────────────────────
describe('orientation and viewport', () => {
  it('derives orientation from the viewport aspect; square counts as portrait', () => {
    stubViewport(390, 844);
    expect(orientation()).toBe('portrait');
    stubViewport(844, 390);
    expect(orientation()).toBe('landscape');
    stubViewport(500, 500);
    expect(orientation()).toBe('portrait');
  });

  it('matches the layout layer\'s own rule — the two must never disagree about what portrait means', async () => {
    // deviceContext deliberately does NOT import detectOrientation (that module pulls in PIXI and the
    // engine, and this one has to stay loadable on the bare crash path). That duplication is only safe
    // while the two agree, so pin them together here rather than trusting a comment.
    const { detectOrientation } = await import('../src/layout/ScalingManager');
    for (const [w, h] of [[390, 844], [844, 390], [500, 500], [1920, 1080]] as const) {
      stubViewport(w, h);
      expect(orientation()).toBe(detectOrientation(w, h));
    }
  });

  it('omits fields it cannot read instead of reporting an empty value', () => {
    vi.stubGlobal('innerWidth', undefined);
    vi.stubGlobal('innerHeight', undefined);
    expect(orientation()).toBeUndefined();
    expect(momentContext()).toEqual({});
  });

  it('reports the viewport as WxH and carries no sinceRot until the screen actually rotates', () => {
    stubViewport(390, 844);
    expect(momentContext()).toEqual({ orient: 'portrait', vp: '390x844' });
  });
});

// ── rotation tracking ────────────────────────────────────────────────────────
describe('installRotationWatch', () => {
  it('records a flip and starts reporting sinceRot from it', () => {
    vi.useFakeTimers();
    stubViewport(390, 844);
    const fire = captureListeners();
    installRotationWatch();
    expect(lastRotationAt()).toBeUndefined();

    stubViewport(844, 390); // device turned sideways
    fire('resize');
    expect(lastRotationAt()).toBeDefined();

    vi.advanceTimersByTime(250);
    expect(momentContext()).toEqual({ orient: 'landscape', vp: '844x390', sinceRot: 250 });
  });

  it('counts one flip per rotation, not one per event — three listeners fire for a single turn', () => {
    vi.useFakeTimers();
    stubViewport(390, 844);
    const fire = captureListeners();
    const onRotate = vi.fn();
    installRotationWatch(onRotate);

    stubViewport(844, 390);
    // What a real iOS rotation looks like: orientationchange plus a burst of resizes as the viewport
    // is reported progressively through the animation.
    fire('orientationchange');
    fire('resize');
    fire('resize');
    expect(onRotate).toHaveBeenCalledTimes(1);
  });

  it('ignores resizes that are not rotations — keyboards and chrome bars fire these constantly', () => {
    stubViewport(390, 844);
    const fire = captureListeners();
    const onRotate = vi.fn();
    installRotationWatch(onRotate);

    stubViewport(390, 500); // on-screen keyboard: much shorter, still portrait
    fire('resize');
    expect(onRotate).not.toHaveBeenCalled();
    expect(lastRotationAt()).toBeUndefined();
  });

  it('installs once, however many times it is called', () => {
    stubViewport(390, 844);
    const fire = captureListeners();
    const onRotate = vi.fn();
    installRotationWatch(onRotate);
    installRotationWatch(vi.fn());

    stubViewport(844, 390);
    fire('resize');
    expect(onRotate).toHaveBeenCalledTimes(1);
  });
});
