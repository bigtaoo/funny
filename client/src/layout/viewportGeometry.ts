// Raw viewport geometry, as a value — the ground truth for "why is the game drawn under the status
// bar?" questions that can only be answered ON the device.
//
// History (2026-09-10). The iPhone-13 portrait bug ("top HUD covers the status bar, ~80pt dead band
// under the bottom nav") was diagnosed twice from arithmetic alone. The first round assumed a WebKit
// cold-boot race in which `env(safe-area-inset-*)` reads 0 (fix: `resettledLayout`, commit
// 60c1aba14) and shipped without a single number off the device; it changed nothing. Working the
// two candidate inset readings through `PortraitLayout`'s design-height formula afterwards showed
// why: NEITHER of them can produce the observed picture.
//
//   insets 47/34 (correct) → designHeight 2113, gameLayer.y = 47, content 47…810 — correct.
//   insets all 0           → designHeight 2337, gameLayer.y = 0,  content 0…844 — no bands at all.
//
// The only combination that produces "top not inset AND ~81pt of blank at the bottom" is a third
// one: the layout viewport has ALREADY been shrunk by the insets (`innerHeight` ≈ 763 on a 844pt
// screen) while `env()` still reports 0 — i.e. WKWebView's own `contentInset` handling did the
// inset, our own inset code saw nothing to do, and the two together inset once but centred wrong.
//
// Reading that off the device is one screenshot of five numbers. Deriving it took two rounds and a
// shipped non-fix, so those five numbers are now printed at boot (`app.ts`) and drawn on the
// settings screen (`SettingsScene`) where the player can photograph them.
//
// Deliberately pure and DOM-free: `app.ts` is on the WeChat reachable graph (no `window` on a real
// mini-game device — see `test/wechatHostSurface.test.ts`), so the reading itself lives behind
// `IPlatform.getViewportGeometry()` and only this shape and its formatter are shared.
import type { SafeAreaInsets } from './ILayout';

/** One snapshot of everything that feeds (or should feed) `createLayout` + `ScalingManager`. */
export interface ViewportGeometry {
  /** `window.innerWidth/innerHeight` — the CSS layout viewport, i.e. what the canvas is sized to. */
  readonly innerW: number;
  readonly innerH: number;
  /** `screen.width/height` — the panel itself. Unaffected by a WebView content inset, which is
   *  exactly what makes it the useful comparison for `innerW/H`. */
  readonly screenW: number;
  readonly screenH: number;
  /** `visualViewport` size + `offsetTop`, or `-1` each where the API is absent. */
  readonly visualW: number;
  readonly visualH: number;
  readonly visualOffsetTop: number;
  /** Raw `devicePixelRatio` (pre-cap; the renderer's own capped value is in `render_profile`). */
  readonly dpr: number;
  /** What `env(safe-area-inset-*)` reports right now. */
  readonly insets: SafeAreaInsets;
  /** True inside the Capacitor shell (`platform/nativeShell.ts`). Load-bearing for {@link viewportVerdict}. */
  readonly nativeShell: boolean;
}

/**
 * One-word reading of a snapshot:
 *
 * - `browser`      — not the native shell. `screen` vs `inner` says nothing here (browser chrome,
 *                    tabs and the URL bar all eat viewport legitimately), so no claim is made.
 * - `env-reported` — `env()` returns a non-zero inset: our own inset path is live and in charge.
 * - `no-inset`     — full-screen viewport and zero insets: a device with nothing to avoid.
 * - `inset-eaten`  — **the 2026-09-10 bug's fingerprint**: the viewport is smaller than the screen
 *                    while `env()` reports nothing, so something below us (WKWebView
 *                    `contentInset`) already inset the page and our layer offset has no idea.
 */
export type ViewportVerdict = 'browser' | 'env-reported' | 'no-inset' | 'inset-eaten';

/** Anything under this is rounding, not an inset. */
const LOST_PX_EPS = 2;

export function viewportVerdict(g: ViewportGeometry): ViewportVerdict {
  if (!g.nativeShell) return 'browser';
  const { top, right, bottom, left } = g.insets;
  if (top > 0 || right > 0 || bottom > 0 || left > 0) return 'env-reported';
  // iOS keeps `screen.width/height` in the panel's own orientation, so compare per-axis against
  // both and take the smaller loss — a rotated device must not read as "eaten" on that alone.
  const lostW = Math.min(Math.abs(g.screenW - g.innerW), Math.abs(g.screenH - g.innerW));
  const lostH = Math.min(Math.abs(g.screenH - g.innerH), Math.abs(g.screenW - g.innerH));
  return lostW >= LOST_PX_EPS || lostH >= LOST_PX_EPS ? 'inset-eaten' : 'no-inset';
}

/**
 * Two short lines for an on-screen readout — short enough to stay legible once design space is
 * scaled down to a phone (a 1080-wide design line renders at 0.36× on a 390pt screen, so one long
 * line would be unreadable in the photo that is the whole point of this).
 */
export function formatViewportGeometry(g: ViewportGeometry): readonly [string, string] {
  const { top, right, bottom, left } = g.insets;
  const vv = g.visualW < 0 ? 'vv n/a' : `vv ${r(g.visualW)}x${r(g.visualH)}@${r(g.visualOffsetTop)}`;
  return [
    `inner ${r(g.innerW)}x${r(g.innerH)} | screen ${r(g.screenW)}x${r(g.screenH)} | dpr ${g.dpr}`,
    `env ${r(top)}/${r(right)}/${r(bottom)}/${r(left)} | ${vv} | ${viewportVerdict(g)}`,
  ];
}

/** Flat, log-friendly shape (`log.info` props must not nest) for the boot line in `app.ts`. */
export function viewportGeometryProps(g: ViewportGeometry): Record<string, number | string | boolean> {
  return {
    innerW: g.innerW, innerH: g.innerH,
    screenW: g.screenW, screenH: g.screenH,
    visualW: g.visualW, visualH: g.visualH, visualOffsetTop: g.visualOffsetTop,
    dpr: g.dpr,
    insetTop: g.insets.top, insetRight: g.insets.right,
    insetBottom: g.insets.bottom, insetLeft: g.insets.left,
    nativeShell: g.nativeShell,
    verdict: viewportVerdict(g),
  };
}

/** Insets and viewport sizes can arrive fractional (zoom); the readout wants one decimal at most. */
function r(v: number): number {
  return Math.round(v * 10) / 10;
}
