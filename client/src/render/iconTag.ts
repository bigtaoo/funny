/**
 * iconTag.ts — stamps every hand-drawn icon with its identity and its drawn size, for the
 * real-browser layout audit (`testing/layoutAudit.ts`).
 *
 * The exact counterpart of `fastText.ts`'s `tagged()`, and it exists for the same reason: once the
 * art is a decoded PNG, an icon is a plain `Sprite` inside a plain `Container`, indistinguishable
 * from any other picture on the page when walking the display tree. The audit therefore had no way
 * to see icons at all — its legibility gate measured text and nothing else, which is how the daily
 * check-in grid's reward glyphs sat at ~12 CSS px on a phone while the sweep that walks that very
 * page reported nothing (2026-09-14 user report; see design/game/UI_DESIGN_LOG_2026-08.md §52).
 *
 * `name` is a stock PIXI field, free to write, and also what the PIXI devtools panel shows. The
 * `icon:` prefix keeps it apart from `fastText`'s `txt:` and from the handful of structural names
 * the battle renderer looks up via `getChildByName` ('sprite', 'hpFill', …).
 *
 * `iconPx` carries the size the caller ASKED for, not the bounds: the art is contain-fitted into a
 * square box, so a wide glyph's bounds are shorter than the box it was given and a bounds-derived
 * number would read every non-square icon as smaller than it is. It is the same distinction
 * `fsPx` makes for baked labels, for the same reason.
 */
import type * as PIXI from 'pixi.js-legacy';

/**
 * Tag `node` as the icon `id` drawn at `size` design px. Returns the node, so builders can
 * `return tagIcon(box, url, s)`.
 *
 * `id` is whatever the builder knows — an `IconKind` where it has one, else the art url, which the
 * audit shortens to its file name. Either way it names the picture in a finding, which is the
 * whole point: "an icon is too small" is not actionable, "tabicon_coin at 6.7 CSS px" is.
 */
export function tagIcon<T extends PIXI.DisplayObject>(node: T, id: string, size: number): T {
  node.name = `icon:${id}`;
  (node as unknown as { iconPx?: number }).iconPx = size;
  return node;
}

/**
 * Drop the tag {@link tagIcon} put on `node`, so the audit's icon gate skips it.
 *
 * For REPEATED PIPS only - a row of level stars (`render/levelStars.ts`) being the whole population
 * today. The gate's premise is that a pictogram has no fallback: you either resolve the picture or
 * you have nothing. A pip is the opposite - the unit of meaning is the ROW's length, and three gold
 * specks still read as three even when no single one resolves into a star. Holding each pip to the
 * text floor reports 231 findings on one phone viewport (measured 2026-09-14) for a widget whose
 * information survives the size.
 *
 * It is an exemption from the gate, not from the problem: at 12-15 design px those stars really are
 * ~5 CSS px on a phone, and the reason is the open one - portrait's design width
 * (UI_DESIGN_LOG_2026-08.md 49.1). Raising the size alone buys nothing, because every caller passes
 * a `maxW` that shrinks the row straight back down; it needs the width, not the constant.
 */
export function untagIcon<T extends PIXI.DisplayObject>(node: T): T {
  node.name = null;
  delete (node as unknown as { iconPx?: number }).iconPx;
  return node;
}
