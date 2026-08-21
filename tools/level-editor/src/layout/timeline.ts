import { ATTACK_LANES } from '@nw/engine/config';
import { TICK_RATE } from '@nw/engine/math/fixed';
import type { WaveEntry } from '@nw/engine/campaign/LevelDefinition';
import { unitMeta } from '../units';

/**
 * Wave timeline layout — the PURE half of `timeline/TimelinePanel.ts` (ADR-070
 * Phase 4b).
 *
 * Answers, for the timeline canvas (DESIGN.md §9: X = time in seconds, Y = one
 * row per ATTACK_LANE in declaration order): where does a tick land in pixels
 * and back, which lane row is a Y in, what rectangle does a {@link WaveEntry}
 * occupy, what is under the cursor, and how do pan/zoom/drag-snap move the
 * viewport. No canvas, no DOM, no `this` — {@link TimelinePanel} owns the
 * `<canvas>` and the listeners and delegates every one of these decisions here.
 */

/** Lane-label gutter width; also the X origin of tick 0 at scrollX = 0. */
export const GUTTER_W = 56;
export const RULER_H = 22;
export const LANE_H = 30;
/** Drag snap granularity: 3 ticks = 0.1s. */
export const SNAP_TICKS = 3;
const MIN_PPS = 12;
const MAX_PPS = 400;
/** Zoom step per wheel notch. */
const ZOOM_FACTOR = 1.15;
/** Minimum block width, and the slack a block gets past its last unit's tick. */
const BLOCK_PAD = 18;
/** Extra pixels of grab tolerance on a block's left edge. */
const HIT_SLACK = 4;

/** Timeline palette. Data, not drawing — the canvas half reads it. */
export const C = {
  bg: '#11111b',
  gutter: '#242436',
  ruler: '#242436',
  laneA: '#1c1c2c',
  laneB: '#191926',
  grid: '#2e2e46',
  gridSec: '#3a3a58',
  text: '#cdd6f4',
  dim: '#6e6e8a',
  sel: '#f5e0dc',
  boss: '#f9e2af',
};

/** A block's screen rectangle on the timeline canvas. */
export interface BlockRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function tickToX(tick: number, pxPerSec: number, scrollX: number): number {
  return GUTTER_W + (tick / TICK_RATE) * pxPerSec - scrollX;
}
export function xToTick(x: number, pxPerSec: number, scrollX: number): number {
  return ((x - GUTTER_W + scrollX) / pxPerSec) * TICK_RATE;
}
export function laneIndex(col: number): number {
  return (ATTACK_LANES as readonly number[]).indexOf(col);
}
export function yToLaneIndex(y: number): number {
  return Math.floor((y - RULER_H) / LANE_H);
}
export function entryEndTick(e: WaveEntry): number {
  return e.atTick + Math.max(0, e.count - 1) * (e.spacingTicks ?? 0);
}

/** The attack-lane column a Y falls in, or null outside the lane rows. */
export function laneColAt(y: number, laneCount: number): number | null {
  const li = yToLaneIndex(y);
  if (li < 0 || li >= laneCount) return null;
  return (ATTACK_LANES as readonly number[])[li]!;
}

/** Canvas height for a lane count (ruler strip + one row per lane). */
export function canvasHeight(laneCount: number): number {
  return RULER_H + laneCount * LANE_H;
}

/** The rectangle a wave entry's block occupies on its lane row. Single source of
 *  truth for the block's extent: {@link hitTest} tests against this same rect,
 *  so the grabbable area and the drawn area cannot drift apart (before Phase 4b
 *  they were two separate expressions of the right edge inside two methods). */
export function blockRect(e: WaveEntry, laneIdx: number, pxPerSec: number, scrollX: number): BlockRect {
  const x = tickToX(e.atTick, pxPerSec, scrollX);
  const end = tickToX(entryEndTick(e), pxPerSec, scrollX);
  return {
    x,
    y: RULER_H + laneIdx * LANE_H + 4,
    w: Math.max(BLOCK_PAD, end - x + BLOCK_PAD),
    h: LANE_H - 8,
  };
}

/** Whether any of a block is on screen (blocks fully off either side are skipped). */
export function isBlockVisible(rect: BlockRect, canvasWidth: number): boolean {
  return rect.x + rect.w >= GUTTER_W && rect.x <= canvasWidth;
}

/** X positions of the per-unit spacing ticks drawn inside a block (one per unit
 *  after the first). Empty for single units and for zero spacing. */
export function unitTickXs(e: WaveEntry, pxPerSec: number, scrollX: number): number[] {
  const spacing = e.spacingTicks ?? 0;
  if (e.count <= 1 || spacing <= 0) return [];
  const xs: number[] = [];
  for (let k = 1; k < e.count; k++) xs.push(tickToX(e.atTick + k * spacing, pxPerSec, scrollX));
  return xs;
}

/** A block's caption: unit label (falling back to the raw enum value), count,
 *  and a star for boss entries. */
export function blockLabel(e: WaveEntry): string {
  const meta = unitMeta(e.unitType);
  return `${meta.label || meta.type}×${e.count}${e.isBoss ? ' ★' : ''}`;
}

/** Topmost/last block under the cursor, on whichever lane row it falls in. */
export function hitTest(
  x: number, y: number,
  entries: readonly WaveEntry[], laneCount: number,
  pxPerSec: number, scrollX: number,
): number | null {
  const lane = laneColAt(y, laneCount);
  if (lane === null) return null;
  const li = yToLaneIndex(y);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.col !== lane) continue;
    const r = blockRect(e, li, pxPerSec, scrollX);
    if (x >= r.x - HIT_SLACK && x <= r.x + r.w) return i;
  }
  return null;
}

/** Tick step for the time grid + ruler labels, chosen so labels stay readable at
 *  the current zoom. Every 5th step is drawn brighter (see {@link isMajorSecond}). */
export function gridStepSec(pxPerSec: number): number {
  return pxPerSec >= 120 ? 1 : pxPerSec >= 50 ? 2 : 5;
}

/** Whether a gridline second gets the brighter major colour. */
export function isMajorSecond(sec: number, stepSec: number): boolean {
  return sec % (stepSec * 5) === 0;
}

/** Inclusive range of whole seconds visible between the gutter and `width`,
 *  clamped at 0 (time never runs negative). */
export function visibleSecondRange(pxPerSec: number, scrollX: number, width: number): { startSec: number; endSec: number } {
  return {
    startSec: Math.max(0, Math.floor(xToTick(GUTTER_W, pxPerSec, scrollX) / TICK_RATE)),
    endSec: Math.ceil(xToTick(width, pxPerSec, scrollX) / TICK_RATE),
  };
}

/** New `atTick` for a horizontal drag: snapped to {@link SNAP_TICKS} and clamped ≥ 0. */
export function snapAtTick(origAtTick: number, deltaTicks: number): number {
  const atTick = Math.round((origAtTick + deltaTicks) / SNAP_TICKS) * SNAP_TICKS;
  return atTick < 0 ? 0 : atTick;
}

/** Ctrl/⌘+wheel zoom: scale `pxPerSec` (clamped) while keeping the tick under
 *  the cursor stationary. `deltaY < 0` (wheel up / pinch out) zooms in. */
export function zoomAround(pxPerSec: number, scrollX: number, x: number, deltaY: number): { pxPerSec: number; scrollX: number } {
  const tickAtCursor = xToTick(x, pxPerSec, scrollX);
  const factor = deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
  const next = Math.min(MAX_PPS, Math.max(MIN_PPS, pxPerSec * factor));
  return { pxPerSec: next, scrollX: clampScroll(GUTTER_W + (tickAtCursor / TICK_RATE) * next - x) };
}

/** Plain wheel pan (both axes feed the horizontal scroll), clamped ≥ 0. */
export function panBy(scrollX: number, deltaY: number, deltaX: number): number {
  return clampScroll(scrollX + deltaY + deltaX);
}

function clampScroll(scrollX: number): number {
  return scrollX < 0 ? 0 : scrollX;
}
