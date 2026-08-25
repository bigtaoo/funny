// Incremental repaints for FamilyScene — everything that used to be an unconditional full render().
//
// Straight port of SectScene/repaint.ts (sect-incremental-repaint, 2026-08-25) onto its twin, same
// day, for the same reason and after the same user report: render() tears down bodyLayer and
// rebuilds every Text/Graphics (member cards with a hand-drawn sketchPanel border each, the chat
// column, the info band, the rail), and four things were driving that far more often than the
// content changed — each of them moving exactly one thing:
//
//   - a drag/wheel scroll, once per frame for the whole gesture;
//   - the focused field's caret, twice a second;
//   - a keystroke in the create-form / channel send box;
//   - BusyTracker.tick() while a mutating action was in flight (this scene draws no dots/loading
//     overlay at all, so those rebuilds changed nothing on screen).
//
// So this class holds the handles needed to move just that thing, and core.update() / input.ts route
// them through here instead of through render(). Every path falls back to a full render() if the
// object it wants is missing or dead, so a missed registration degrades to the old behaviour rather
// than to a stale screen.
//
// Per-COLUMN scroll state ("band"), like the sect page: the landscape split view scrolls the roster
// and the channel independently, and portrait's two tabs own one scroll field each.
//
// Composition over `core` (form ② per claudedocs/client-modules.md's split-form priority note):
// the state here is only ever touched by these methods. Constructed by Core, reachable as
// `core.repaint`.
import * as PIXI from 'pixi.js-legacy';
import { txt } from '../../render/sketchUi';
import { caretDisplay } from '../../ui/inputDisplay';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import type { Rect } from '../../layout/ILayout';
import type { FamilySceneCore } from './core';

/**
 * The scrollable regions this scene can build. 'members'/'channel' are the page columns (portrait
 * shows one at a time, landscape both); 'modal' is whichever list modal is open — it lives in
 * `modalLayer`, which render() never touches, so its rebuild goes through `core.modalRedraw`
 * instead (see applyScroll).
 */
export type ScrollCol = 'members' | 'channel' | 'modal';

/**
 * One column's cheap-scroll state (CardCodexScene/FriendsScene/SectScene precedent): rows were laid out once,
 * at `builtScrollY`, into the masked `layer`, with `overscan` px of extra rows above and below the
 * visible viewport. A drag then just translates that layer, and only falls back to a full render
 * once the position leaves the overscan band.
 */
interface Band {
  layer: PIXI.Container;
  /** Which of core's scroll fields this column reads — see FamilySceneCore.scrollKeyFor. */
  key: 'scrollY' | 'scrollYChannel' | 'modalScrollY';
  /** Extra content height built beyond the viewport in each direction (one viewport height). */
  overscan: number;
  /** The scroll offset the rows inside `layer` were laid out against. */
  builtScrollY: number;
  /** Viewport rect (the content mask's rect) — the scroll indicator is drawn against it. */
  view: Rect;
  /** Scroll extent at build time (`contentH - view.h`), for redrawing the indicator thumb. */
  max: number;
  /** The indicator itself: outside `layer`, so a translate has to redraw it separately. */
  bar: PIXI.Graphics | null;
}

/** The focused input's value Text plus what it takes to rewrite that one string. */
export interface CaretField {
  obj: PIXI.Text;
  value: string;
  placeholder: string;
  /** Ink colour for a value — the channel field greys itself while empty, so a keystroke that
   *  fills or clears it has to recolour the same Text. Omitted for fixed-colour fields. */
  colorFor?: (v: string) => number;
}

export class FamilyRepaint {
  constructor(private readonly core: FamilySceneCore) {}

  private readonly bands = new Map<ScrollCol, Band>();

  /** Set by whichever panel drew the focused field this render (see caretText below). */
  caretField: CaretField | null = null;

  /** Everything above was just destroyed by tearDownChildren — drop the refs so each path falls
   *  back to a full render instead of touching a dead display object. Called from beginRender(). */
  reset(): void {
    this.bands.clear();
    this.caretField = null;
  }

  /** Adopt a freshly built scroll layer for one column, baselined at that column's current scroll. */
  register(col: ScrollCol, band: Omit<Band, 'builtScrollY' | 'overscan'>): void {
    this.bands.set(col, {
      ...band,
      overscan: band.view.h,
      builtScrollY: this.core[band.key],
    });
  }

  /** The scroll layer a column built this render, or null when it built none (a non-'mySect' mode,
   *  or the other column in portrait's tab view). Also what tells a test a drag translated the same
   *  tree rather than rebuilding it. */
  layerFor(col: ScrollCol): PIXI.Container | null {
    const band = this.bands.get(col);
    return band && !band.layer.destroyed ? band.layer : null;
  }

  /** How far a column's scroll can travel before it runs out of pre-built rows and needs a full
   *  render — one viewport height, or 0 when nothing is built. */
  overscanFor(col: ScrollCol): number {
    return this.bands.get(col)?.overscan ?? 0;
  }

  /**
   * How far a column's layer has *actually* been moved — i.e. what the player is looking at. This,
   * not the pending `scrollY - builtScrollY`, is what hit-testing must use: the scroll fields are
   * updated inline by the pointer/wheel handlers but the layer only moves when update() drains the
   * dirty flag on the next frame, so for one frame the two disagree. Offsetting a tap by a translate
   * that has not happened yet lands it on the wrong row (a wheel tick followed by an immediate tap).
   */
  appliedDelta(col: ScrollCol): number {
    const band = this.bands.get(col);
    if (!band || band.layer.destroyed) return 0;
    // `|| 0` normalises the -0 that negating a resting layer.y produces — harmless in arithmetic,
    // but it makes Object.is-based comparisons (vitest's toBe) read as a real offset bug.
    return -band.layer.y || 0;
  }

  /**
   * Drain a scroll change on one column: translate the already-built layer when the new position is
   * still covered by the overscan band, else rebuild the whole scene. reset() clears the bands, so
   * the first scroll after a render that built no scroll layer falls through to render().
   */
  applyScroll(col: ScrollCol): void {
    // A modal is not part of render() — modalLayer survives beginRender untouched — so its rebuild
    // is the closure the modal registered. `?.()` also makes a drag inside a NON-list modal (the
    // confirm dialog, the emblem picker) a no-op instead of a pointless page rebuild.
    const rebuild = col === 'modal'
      ? (): void => { this.core.modalRedraw?.(); }
      : (): void => { this.core.render(); };
    const band = this.bands.get(col);
    if (!band || band.layer.destroyed) { rebuild(); return; }
    const delta = this.core[band.key] - band.builtScrollY;
    if (Math.abs(delta) > band.overscan) { rebuild(); return; }
    band.layer.y = -delta;
    this.drawBar(band);
  }

  /** (Re)draw just one column's scroll thumb, at its current position. */
  private drawBar(band: Band): void {
    if (band.bar) { band.bar.destroy(); band.bar = null; }
    band.bar = drawScrollIndicator(this.core.bodyLayer, band.view, this.core[band.key], band.max);
  }

  /** Swap the caret in or out of the focused field's existing Text. */
  blinkCaret(): void {
    const f = this.caretField;
    if (!f || f.obj.destroyed) { this.core.render(); return; }
    f.obj.text = caretDisplay(f.value, this.core.caretOn, f.placeholder);
  }

  /**
   * Rewrite the focused field's Text after a keystroke. Only the string (and, for the channel
   * field, its ink colour) can change: every field on this scene sits in a fixed-width panel with
   * its own hit rect, so nothing around it needs re-laying-out.
   */
  setFieldValue(value: string): void {
    const f = this.caretField;
    if (!f || f.obj.destroyed) { this.core.render(); return; }
    f.value = value;
    f.obj.text = caretDisplay(value, this.core.caretOn, f.placeholder);
    if (f.colorFor) f.obj.style.fill = f.colorFor(value);
  }
}

/**
 * The value Text for an on-canvas text field: renders `value` with a blinking caret while focused,
 * and — when focused — registers itself so the 0.5 s blink and each keystroke can rewrite that one
 * string instead of the whole tree (see FamilyRepaint above). Every field on this scene goes through
 * here so none can drift back into the old "draw a caret nobody can cheaply update" shape.
 *
 * The caller still positions/anchors the returned Text and adds it to its own parent. Mirrors
 * FriendsScene/chrome.ts's and SectScene/repaint.ts's caretText.
 */
export function caretText(core: FamilySceneCore, opts: {
  active: boolean;
  value: string;
  size: number;
  /** Ink colour. Pass a function when it depends on the value (see CaretField.colorFor). */
  color: number | ((v: string) => number);
  /** Shown in place of the value when the field is empty and the caret is off. */
  placeholder: string;
}): PIXI.Text {
  const colorFor = typeof opts.color === 'function' ? opts.color : null;
  const obj = txt(
    caretDisplay(opts.value, opts.active && core.caretOn, opts.placeholder),
    opts.size,
    colorFor ? colorFor(opts.value) : (opts.color as number),
  );
  if (opts.active) {
    core.repaint.caretField = {
      obj, value: opts.value, placeholder: opts.placeholder,
      ...(colorFor ? { colorFor } : {}),
    };
  }
  return obj;
}
