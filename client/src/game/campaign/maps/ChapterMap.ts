import type { TranslationKey } from '../../../i18n';

/**
 * Chapter map data model (CAMPAIGN_DESIGN §12.3) — pure data, no PIXI.
 *
 * Describes the *spatial layout* of one chapter page in the campaign notebook:
 * where each level's node sits, how the pencil trail threads them, and what
 * doodle props decorate the venue. Level *numbers* (waves / objective / rewards)
 * stay single-sourced in `levels/*.json`; a node only references a level by
 * `levelId`, so the two data sets never duplicate each other.
 *
 * All coordinates are normalized to the page content rectangle (`0..1`) so one
 * authored layout adapts to portrait / landscape / any resolution.
 */
export interface ChapterMap {
  /** Chapter index (1-based), matching the `ch{N}_lv{M}` level ids. */
  chapter: number;
  /** i18n key for the venue name shown in the page header ("第 N 章 · 演武场"). */
  venueKey: TranslationKey;
  /** Level nodes in play order; `levelId` must resolve in CAMPAIGN_LEVELS. */
  nodes: ChapterNode[];
  /**
   * Pencil trail connecting the nodes. `'auto'` (default) draws a dashed line
   * through `nodes` in array order; an explicit point list overrides the route
   * for hand-shaped curves. Omitted ⇒ treated as `'auto'`.
   */
  path?: 'auto' | NormPoint[];
  /** Procedural doodle props (start/boss markers, venue scenery). */
  decor?: ChapterDecor[];
}

/** One level node, positioned in normalized page space. */
export interface ChapterNode {
  /** Stable level id, e.g. 'ch1_lv1' — must exist in CAMPAIGN_LEVELS. */
  levelId: string;
  /** Normalized x ∈ 0..1 within the page content rect. */
  x: number;
  /** Normalized y ∈ 0..1 within the page content rect. */
  y: number;
}

/** A normalized point on the page (0..1 on both axes). */
export interface NormPoint {
  x: number;
  y: number;
}

/**
 * One decorative doodle. `kind` is a free string the renderer maps to a sketch
 * routine; unknown kinds are skipped (forward-compatible). Conventional kinds:
 * 'start', 'boss', 'flag', 'rack', 'banner', 'tent', 'tree', 'rock'.
 */
export interface ChapterDecor {
  kind: string;
  x: number;
  y: number;
}
