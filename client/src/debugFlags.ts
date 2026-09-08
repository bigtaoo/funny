// One storage seam for the diagnostic knobs (`nw_*`) the perf/memory/render watchdogs read.
//
// Why this module exists: every one of those knobs used to read `globalThis.localStorage` directly,
// which silently does nothing on the two hosts whose numbers we most need — WeChat mini-game has no
// global `localStorage` at all (it has `wx.getStorageSync`, reached through `platform.storage`), and
// every read was wrapped in a `try {} catch {}` that returned the default, so nothing ever reported
// a problem. The practical effect was that `nw_render_debug` / `nw_fps_warn` / `nw_mem_warn_mb`
// looked like they worked everywhere and worked only on web: on WeChat the paint-rate counter was
// never published, so "how often does this build actually repaint on a phone" could not be answered
// on the host that needed it most (ADR-083's dpr cap is a no-op there by construction —
// `WechatPlatform.devicePixelRatio` is hardcoded to 1 — so demand-driven painting is the ONLY one of
// its three knobs that does anything on WeChat, and it was the unmeasurable one).
//
// `net/anomaly/reporter.ts` had already hit and solved exactly this (`setAnomalyStorage`); this is
// the same seam for the flags, so the fix does not have to be repeated a fourth time.
//
// These are diagnostics, never gameplay: a flag that cannot be read must degrade to the default,
// which is why every accessor here swallows storage errors rather than propagating them.
import type { IStorage } from './platform/IPlatform';

/** Fallback shim: web behaviour, and what tests that stub `globalThis.localStorage` keep seeing. */
const localStorageShim: Pick<IStorage, 'getItem'> = {
  getItem: (k) => {
    try { return globalThis.localStorage?.getItem(k) ?? null; } catch { return null; }
  },
};

let storage: Pick<IStorage, 'getItem'> = localStorageShim;

/**
 * Wire in the real platform storage. Call once from app.ts BEFORE the watchdogs install, next to
 * `setAnomalyStorage` — on WeChat/native nothing below reads anything until this has run.
 */
export function setDebugFlagStorage(s: Pick<IStorage, 'getItem'>): void { storage = s; }

/** Test seam: drop back to the `globalThis.localStorage` shim. */
export function resetDebugFlagStorage(): void { storage = localStorageShim; }

/** Raw string value of a debug flag, or null when unset / unreadable. */
export function debugFlag(key: string): string | null {
  try { return storage.getItem(key); } catch { return null; }
}

/** Positive-number debug flag, falling back to `fallback` when unset, unreadable or not a number. */
export function debugNum(key: string, fallback: number): number {
  const raw = debugFlag(key);
  const v = raw == null ? NaN : Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
