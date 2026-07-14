// ADR-039 "连地" occupy-frontier computation, split out of the renderer so it is unit-testable without PIXI.
// A frontier cell = a neutral, occupiable tile 4-directionally adjacent to the player's own / same-family
// territory (the own capital's 3×3 footprint always counts, even if a ring cell lost its ownerId). This is
// the client-visible half of the connectivity rule enforced server-side by isConnectedToSectTerritory —
// used to draw the "here's where you can expand" outline. 4-directional (shared-edge) on purpose: a
// grid-diagonal tile only touches at a corner (it merely *looks* adjacent in the isometric projection).
import { proceduralTile, baseFootprintCells } from '@nw/shared';

/** Minimal tile shape the frontier scan reads (subset of WorldTileView). */
export interface FrontierTile {
  occupied?: boolean;
  mine?: boolean;
  ally?: boolean;
  contestedUntil?: number;
  visible?: boolean;
}

export interface OccupyFrontierParams {
  worldId: string;
  mapW: number;
  mapH: number;
  /** Inclusive tile-index scan window (usually the visible viewport). */
  bounds: { minTx: number; maxTx: number; minTy: number; maxTy: number };
  /** Player's capital anchor tileId (its 3×3 footprint is guaranteed initial territory). */
  mainBaseTile?: string | null;
  /** `${x}:${y}` → tile view (only occupied tiles are present; neutrals are absent). */
  tileCache: ReadonlyMap<string, FrontierTile>;
  /** Parse a tileId ("world:x:y") into [x, y]; null if malformed. */
  parseAnchor: (tileId: string) => [number, number] | null;
}

/**
 * Returns the occupiable frontier tiles within `bounds`: neutral + occupiable terrain, not fogged / mid-hold,
 * and 4-adjacent to a tile the player owns (own capital footprint, or a `mine`/`ally` tile). Order follows the
 * scan (row-major); callers dedupe implicitly since each (x,y) is visited once.
 */
export function occupyFrontierCells(params: OccupyFrontierParams): { x: number; y: number }[] {
  const { worldId, mapW, mapH, bounds, mainBaseTile, tileCache, parseAnchor } = params;

  const baseCells = new Set<string>();
  if (mainBaseTile) {
    const anchor = parseAnchor(mainBaseTile);
    if (anchor) for (const c of baseFootprintCells(anchor[0], anchor[1])) baseCells.add(`${c.x}:${c.y}`);
  }
  const ownsCell = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= mapW || y >= mapH) return false;
    if (baseCells.has(`${x}:${y}`)) return true;
    const t = tileCache.get(`${x}:${y}`);
    return !!(t && (t.mine || t.ally));
  };

  const out: { x: number; y: number }[] = [];
  for (let ty = Math.max(0, bounds.minTy); ty <= Math.min(mapH - 1, bounds.maxTy); ty++) {
    for (let tx = Math.max(0, bounds.minTx); tx <= Math.min(mapW - 1, bounds.maxTx); tx++) {
      if (baseCells.has(`${tx}:${ty}`)) continue; // own capital footprint — not a target
      const tile = tileCache.get(`${tx}:${ty}`);
      if (tile?.occupied) continue;               // already owned by someone (incl. self)
      if (tile?.contestedUntil) continue;          // mid occupation-hold — occupy would bounce
      if (tile?.visible === false) continue;       // fogged — don't reveal frontier into unseen land
      const proc = proceduralTile(worldId, tx, ty);
      if (proc.type === 'center' || proc.type === 'obstacle' || proc.type === 'stronghold' || proc.type === 'bridge' || proc.type === 'plankway') continue;
      if (!(ownsCell(tx - 1, ty) || ownsCell(tx + 1, ty) || ownsCell(tx, ty - 1) || ownsCell(tx, ty + 1))) continue;
      out.push({ x: tx, y: ty });
    }
  }
  return out;
}
