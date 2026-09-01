// The shared hit table + its dispatcher (AUDIO_DESIGN.md §7 step 4, "UI 触发点").
//
// **Why this file had to exist before any UI sound could**: this codebase has no button base
// class. 40 scenes each accumulate their own flat list of tappable rectangles, each does its own
// containment test, each calls the callback itself — and 22 of them declared their own
// `interface Hit` to describe it (plus a dozen more that inlined the same shape as
// `hitRects: { rect; action }[]`, identical but for the callback's name). Wiring "a button makes
// a sound" into that world would have meant a `playSfx('sfx.ui.tap')` line at several hundred
// call sites: a duplication guaranteed to be incomplete on the day it landed and to rot after.
//
// So the order is inverted. Collapse the table and its dispatch to here first, and the sound
// becomes a single call site ({@link runHit}), while "what should this button sound like"
// degrades to one optional field next to `fn`. A new scene gets the tap cue for free; the only
// buttons that need to say anything are the ones that are *not* a tap (back/close).
//
// Three entry points rather than one, because the scenes' gestures genuinely differ:
//  * {@link dispatchHit} — fire on pointer-down (most non-scrolling scenes).
//  * {@link hitTest} / {@link runHit} — split, for callers that must do something between the
//    two (scroll-space remapping, modal layering, owner bookkeeping).
//  * {@link hitAction} — wrap the hit in a closure for `ScrollTapGesture`, which decides on
//    pointer-up whether the gesture was a tap or a scroll. The cue rides along with the closure,
//    so a hit dropped as a drag stays silent.
import type { Rect } from '../layout/ILayout';
import type { AudioCue } from '../audio/types';
import { playSfx } from '../audio/audioBus';

export type { Rect };

/**
 * One tappable rectangle.
 *
 * `S` is the scene's own scroll-column tag. Most scenes don't scroll (the `never` default makes
 * writing `scroll` a compile error), some want `Hit<boolean>` ("is this inside the one scrollable
 * region"), and Family/Sect use a literal union like `Hit<'members' | 'modal'>`. It is a type
 * parameter rather than a widened `string | boolean` so those scenes keep the exhaustiveness
 * checking they already had.
 */
export interface Hit<S = never> {
  rect: Rect;
  fn: () => void;
  /**
   * What this tap sounds like. **Omitted means `sfx.ui.tap`** — a default rather than a required
   * field, because nearly every button is an ordinary tap and forcing all of them to say so would
   * make the handful that were forgotten look deliberate. An explicit `null` is silence, for
   * rectangles that are not buttons (e.g. a transparent blocker that only swallows taps).
   */
  sound?: AudioCue | null;
  /** The scene's own scroll-column tag; this module never interprets it. */
  scroll?: S;
  /** Ownership tag (e.g. a card instance id) so a scene can replace just that row's hits. */
  owner?: string;
}

/** Rectangle containment. Edges count as inside — verbatim what the hand-written tests all did. */
export function inRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/**
 * The first entry containing the point (first pushed wins), or `undefined`.
 *
 * The generic only constrains `rect`, so tables that have not collapsed onto {@link Hit} — the
 * `{ rect, onDrag }` slider lists — can share the containment test. They are not buttons and
 * deliberately do not go through {@link runHit}.
 */
export function hitTest<T extends { rect: Rect }>(hits: readonly T[], x: number, y: number): T | undefined {
  for (const h of hits) if (inRect(x, y, h.rect)) return h;
  return undefined;
}

/**
 * Fire a hit: **sound first, then the action**.
 *
 * The order is deliberate. `fn` is very often a synchronous `render()` that rebuilds a whole
 * display tree, or a call that swaps the scene outright; queueing the cue behind it would push
 * the feedback to the end of that frame and read as a lag. `playSfx` swallows everything it can
 * throw (see audio/audioBus.ts), so going first cannot cost the caller its action.
 *
 * This is the only place in the UI layer that emits a UI cue — the one exception being
 * `sfx.ui.error`, which is raised by the global toast outlet because a failure arrives from an
 * async result, not from the tap that started it.
 */
export function runHit(hit: { fn: () => void; sound?: AudioCue | null }): void {
  const cue = hit.sound === undefined ? 'sfx.ui.tap' : hit.sound;
  if (cue) playSfx(cue);
  hit.fn();
}

/** Hit-test and fire in one step. Returns whether anything was hit. */
export function dispatchHit<S>(hits: readonly Hit<S>[], x: number, y: number): boolean {
  const hit = hitTest(hits, x, y);
  if (!hit) return false;
  runHit(hit);
  return true;
}

/**
 * The listener form, for the buttons that are real PIXI display objects with their own
 * `eventMode = 'static'` + `on('pointertap', ...)` and therefore never had a hit table at all:
 * ResultScene's CTAs and back chip, ReplayScene, StatePlayerScene, and the five modal dialogs
 * (`ui/dialogs/**`). They are a genuinely different mechanism — PIXI does the hit-testing, the
 * scene does not own a rect list — but they are the same *thing* to the player, so they route
 * through the same {@link runHit} rather than growing a second cue outlet.
 *
 * `test/uiTapSoundCoverage.test.ts` is what keeps this honest: it scans src/ and fails on any
 * `on('pointertap', ...)` whose handler is not wrapped here, because a silent button is invisible
 * to every other kind of test — it renders, it fires, it just does not sound.
 */
export function tapHandler(fn: () => void, sound?: AudioCue | null): () => void {
  return (): void => runHit({ fn, sound });
}

/**
 * Wrap the hit under the point in a deferred closure for `ScrollTapGesture.down()`, which hit-tests
 * on pointer-down but only fires on pointer-up if the gesture stayed a tap. Returns `null` on a
 * miss — the shape that API already expects.
 */
export function hitAction<S>(hits: readonly Hit<S>[], x: number, y: number): (() => void) | null {
  const hit = hitTest(hits, x, y);
  return hit ? (): void => runHit(hit) : null;
}
