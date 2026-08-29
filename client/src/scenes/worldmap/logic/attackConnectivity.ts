// ADR-039 "连地" (territory-connectivity) client-side pre-check for ATTACK/SIEGE targets, mirroring
// worldsvc's core.isConnectedToSectTerritory + targetFootprintCells (startMarchValidation.ts) — the
// same rule WorldMapInput.occupyConnected already applies to the neutral-tile Occupy button, extended
// here to the enemy-tile / stronghold / wild-city Attack path.
//
// 2026-08-29 user report: attacking an enemy base or neutral city that doesn't border the player's own
// territory got the wrong "尚无队伍，先去编辑布阵" toast (showTeamPicker's usable-teams-empty fallback)
// whenever every owned team happened to be busy elsewhere — the real (and, in that scenario, the ONLY
// actual) blocker is TERRITORY_NOT_CONNECTED, but the request never reaches startMarch to surface it
// (no usable team → the picker never dispatches). Checking connectivity BEFORE opening the picker lets
// showTeamPicker surface the real reason (world.err.notConnected) immediately, regardless of team
// availability.
//
// Same scope guard as occupyConnected: SOLO players only (no familyId). The server counts own family ∪
// sibling families in the same sect, but the client only tags its own family's tiles — a sibling
// family's territory carries no client flag, so for anyone in a family this cannot disprove
// connectivity and must defer to the server. Returns true (=connected) whenever it cannot be
// confidently disproven.
import { baseFootprintCells, cityNodeCovering } from '@nw/shared';
import type { WorldMapContext } from '../WorldMapContext';

/**
 * True iff any cell of `cells` 4-directionally borders the player's own territory — own captured
 * tiles, or their own 3×3 capital footprint (guaranteed initial territory, SLG_DESIGN §4.1) regardless
 * of per-cell `mine` staleness. A footprint's own cells never count as their own neighbor (mirrors the
 * server's targetKeys filter).
 */
export function territoryConnected(ctx: WorldMapContext, cells: { x: number; y: number }[]): boolean {
  const me = ctx.me;
  if (me?.familyId) return true; // sibling-sect territory invisible client-side — defer to the server
  const baseCells = new Set<string>();
  if (me?.mainBaseTile) {
    const [bx, by] = ctx.parseTileId(me.mainBaseTile);
    for (const c of baseFootprintCells(bx, by)) baseCells.add(`${c.x}:${c.y}`);
  }
  const cellKeys = new Set(cells.map((c) => `${c.x}:${c.y}`));
  for (const { x, y } of cells) {
    for (const n of [{ x: x - 1, y }, { x: x + 1, y }, { x, y: y - 1 }, { x, y: y + 1 }]) {
      if (cellKeys.has(`${n.x}:${n.y}`)) continue; // the footprint's own cells never count as their own neighbor
      if (n.x < 0 || n.y < 0 || n.x >= ctx.mapW || n.y >= ctx.mapH) continue;
      if (baseCells.has(`${n.x}:${n.y}`)) return true;
      if (ctx.tileCache?.get(`${n.x}:${n.y}`)?.mine) return true;
    }
  }
  return false;
}

/**
 * Footprint cells for an attack/siege target at (tx,ty), mirroring worldsvc's targetFootprintCells: a
 * capital checks its whole 3×3 ring and a wild city checks its whole plot (both are only ever bordered
 * at their outer perimeter, never at a single interior cell) — everything else is just the tapped cell.
 *
 * WorldTileView carries no baseAnchor field, so an enemy base's anchor is recovered by scanning the
 * tapped cell's own 3×3 neighborhood for the cell whose 4 neighbors are all also type 'base' (the same
 * test WorldMapRendererPool.isBaseAnchor uses for the render layer) — the tapped cell itself is
 * somewhere inside that 3×3, since a base footprint is only ever 3 wide. Falls back to the single
 * tapped cell if no candidate resolves (edge-of-vision cache gaps) rather than guessing a wrong anchor.
 */
export function attackFootprintCells(ctx: WorldMapContext, tx: number, ty: number): { x: number; y: number }[] {
  const tile = ctx.tileCache?.get(`${tx}:${ty}`);
  if (tile?.type === 'base') {
    for (let ay = ty - 1; ay <= ty + 1; ay++) {
      for (let ax = tx - 1; ax <= tx + 1; ax++) {
        const ring: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
        if (ctx.tileCache?.get(`${ax}:${ay}`)?.type === 'base' && ring.every(([dx, dy]) => ctx.tileCache?.get(`${ax + dx}:${ay + dy}`)?.type === 'base')) {
          return baseFootprintCells(ax, ay);
        }
      }
    }
    return [{ x: tx, y: ty }];
  }
  if (tile?.type === 'familyKeep' && ctx.cityNodes) {
    const city = cityNodeCovering(ctx.cityNodes, tx, ty);
    if (city) {
      const r = (city.footprint - 1) / 2;
      const out: { x: number; y: number }[] = [];
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) out.push({ x: city.x + dx, y: city.y + dy });
      return out;
    }
  }
  return [{ x: tx, y: ty }];
}
