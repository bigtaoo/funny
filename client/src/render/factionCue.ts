// Faction cues shared by the board's static art (bases, barracks, arrow towers): which ink an
// owner draws in, and the soft ground wash at the foot of a full-colour/ink AI asset. Lives apart
// from BoardView/bases.ts so BuildingView can draw the same patch without pulling the base
// lifecycle (and its atlas/game imports) into the building view.
import type * as PIXI from 'pixi.js-legacy';
import type { Side } from '@nw/engine/types';
import type { Rect } from '../layout/ILayout';
import { factionInk } from './theme';

/**
 * Faction ink for something owned by `side`, as seen by the player sitting at `localSide`:
 * ours = blue, theirs = red (art-direction §3.2). Keyed on "is it the local player's", never on
 * the raw side — the PvP joiner plays Side.Top, and their own buildings must still be blue.
 */
export function factionInkFor(side: Side, localSide: Side): number {
  return side === localSide ? factionInk.friend : factionInk.enemy;
}

/**
 * Three stacked ellipses centred on (cx, cy): a wide soft halo, a mid disc, a stronger core.
 * Static — drawn once per owner change, never per frame (art-direction §3.4 bans standing
 * outline glow and per-frame filters on the board).
 */
export function drawFactionWash(
  g: PIXI.Graphics, color: number, cx: number, cy: number, rx: number, ry: number,
): void {
  g.clear();
  g.beginFill(color, 0.16); g.drawEllipse(cx, cy, rx * 1.3, ry * 1.3); g.endFill();
  g.beginFill(color, 0.24); g.drawEllipse(cx, cy, rx,       ry);       g.endFill();
  g.beginFill(color, 0.34); g.drawEllipse(cx, cy, rx * 0.6, ry * 0.6); g.endFill();
}

/**
 * Idle faction ground patch under each base (敌红我蓝, art-direction §3.2): a soft
 * layered color wash at the castle's foot, drawn once and left static — same
 * "colored ground patch under a full-color AI asset" language as UnitView's
 * drawFactionMarker, not a persistent outline (§3.4 explicitly bans standing
 * outline glow: it beats against the hand-drawn ink linework and moirés).
 */
export function drawFactionGroundPatch(g: PIXI.Graphics, color: number, rect: Rect): void {
  // Castle art sits high in its frame; the patch anchors near its foot.
  drawFactionWash(g, color, 0, rect.h * 0.32, rect.w * 0.34, rect.h * 0.1);
}
