// visibleBoot.ts — hold the first screen of a page that booted in a background tab until it is
// actually on screen and its viewport has stopped moving.
//
// Why (2026-10-05, CrazyGames QA preview): a game booted in a hidden tab measured a PORTRAIT
// viewport inside the portal's 722x406 landscape iframe, built the tutorial battle against it, and
// only got the real size once the tab came forward. A match is never rebuilt on a resize
// (app/sceneMounts.ts), so it stayed a portrait page letterboxed into a landscape frame for the
// whole match. The portal's iframe is cross-origin, so what it reports while hidden is not ours to
// fix; what is ours is not committing to a layout before anyone can see it.
//
// A page that boots visible pays nothing: the promise resolves immediately.

/** Quiet period after the page turns visible: no `resize` for this long means the size settled. */
export const SETTLE_QUIET_MS = 300;
/** Upper bound on the settle wait, so a host that keeps firing `resize` cannot wedge the boot. */
export const SETTLE_MAX_MS = 1500;

interface DocLike {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', cb: () => void): void;
  removeEventListener(type: 'visibilitychange', cb: () => void): void;
}
interface WinLike {
  addEventListener(type: 'resize', cb: () => void): void;
  removeEventListener(type: 'resize', cb: () => void): void;
}

/**
 * Resolves at once when the page is visible; otherwise once it turns visible AND no `resize` has
 * fired for {@link SETTLE_QUIET_MS} (capped at {@link SETTLE_MAX_MS} after it turned visible).
 * Timers, not requestAnimationFrame: a just-uncovered window can still be throttled for seconds.
 */
export function untilVisibleAndSettled(
  doc: DocLike | undefined = globalThis.document,
  win: WinLike | undefined = globalThis.window,
): Promise<void> {
  // Only an explicitly hidden page waits. No DOM, or a partial one (a non-browser host, the
  // platform tests' stubs), has nothing to wait for.
  if (doc?.visibilityState !== 'hidden' || typeof doc.addEventListener !== 'function'
    || typeof win?.addEventListener !== 'function') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onVisibility = (): void => {
      if (doc.visibilityState !== 'visible') return;
      doc.removeEventListener('visibilitychange', onVisibility);
      let quiet: ReturnType<typeof setTimeout>;
      const done = (): void => {
        clearTimeout(quiet);
        clearTimeout(cap);
        win.removeEventListener('resize', onResize);
        resolve();
      };
      const onResize = (): void => { clearTimeout(quiet); quiet = setTimeout(done, SETTLE_QUIET_MS); };
      const cap = setTimeout(done, SETTLE_MAX_MS);
      win.addEventListener('resize', onResize);
      quiet = setTimeout(done, SETTLE_QUIET_MS);
    };
    doc.addEventListener('visibilitychange', onVisibility);
  });
}
