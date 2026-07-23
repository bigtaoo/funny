// Shared mouse-wheel scroll math for rect-bounded lists (browser/PC only — WeChat has no wheel
// events, so wiring this into a scene never touches or interferes with its existing touch-drag
// scroll path; see InputManager.onWheel).
//
// Mirrors ScrollTapGesture's philosophy: this stays pure gesture math. The scene keeps its own
// scrollY / maxScroll / dirty-flag (or render()) and decides what counts as "inside the list" —
// same y-only bounds check already used by each scene's `hit.scroll` gating (regionTop/regionBottom).

/**
 * Compute the next scrollY for a wheel event over a vertical list region, or null if the event
 * should be ignored (pointer outside [regionTop, regionBottom], nothing to scroll, or no change).
 */
export function wheelScrollY(
  regionTop: number,
  regionBottom: number,
  y: number,
  deltaY: number,
  scrollY: number,
  maxScroll: number,
): number | null {
  if (maxScroll <= 0 || y < regionTop || y > regionBottom) return null;
  const next = Math.max(0, Math.min(maxScroll, scrollY + deltaY));
  return next !== scrollY ? next : null;
}
