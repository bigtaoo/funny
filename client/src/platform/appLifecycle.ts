// App-level foreground/background/exit signal.
//
// Extracted out of `analytics/index.ts` and `analytics/queue.ts` (2026-09-01), which each carried
// their own copy of the exact same web-vs-WeChat branching (one for churn/session-end tracking,
// one for the hide-flush). Centralizing it here means the branching exists in exactly one place —
// a second consumer, or a future edit to either analytics file, can no longer drift the two apart.
//
// - Web / CrazyGames: `document.visibilitychange` → 'hidden'/'visible', `window.beforeunload` →
//   'exit' (fires once, right before teardown — the page is not coming back).
// - WeChat: this runtime has no DOM, so neither of those exists. `wechatHost.ts` installs
//   `document`/`window` as shims whose `addEventListener` is a deliberate no-op (see its header
//   comment) — silently correct here, not silently broken: `wx.onHide`/`wx.onShow` are the real
//   equivalents and are wired unconditionally below, so the signal still fires. WeChat has no
//   distinct "leaving for good" signal — `wx.onHide` covers both "player switched to another app"
//   (may resume) and the OS suspending/killing the process — so it is always reported as
//   'hidden', never 'exit'.
export type AppLifecycleState = 'visible' | 'hidden' | 'exit';

/** Registers `cb` for every foreground/background/exit transition. Never fires immediately with
 *  the current state — matches both call sites' prior behavior, which only ever cared about
 *  transitions (a page that loads already-hidden is not this module's problem to solve). */
export function onAppLifecycleChange(cb: (state: AppLifecycleState) => void): void {
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      cb(document.visibilityState === 'hidden' ? 'hidden' : 'visible');
    });
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => cb('exit'));
  }
  const wx = (globalThis as { wx?: { onHide?: (cb: () => void) => void; onShow?: (cb: () => void) => void } }).wx;
  if (wx?.onHide) wx.onHide(() => cb('hidden'));
  if (wx?.onShow) wx.onShow(() => cb('visible'));
}
