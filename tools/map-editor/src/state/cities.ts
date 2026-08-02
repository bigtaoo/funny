// Editor-side city node state (DESIGN.md §6.1 third bullet + §6.2 point-node data form).
// Positions start from the generator's `allCityNodes(worldId)` output and are mutated in place by
// dragging — this module holds/mutates that state plus the pure pointer math the City tool needs
// (hit-test + drag clamp); rendering and event wiring live in render/ and input/.
import { allCityNodes, SLG_MAP_H, SLG_MAP_W, type MapEditorCityNode } from '@nw/shared/slg';
import type { TilePoint } from './terrainGrid';

export type { MapEditorCityNode };

export class CityStore {
  nodes: MapEditorCityNode[] = [];

  /** Reloads from the generator, discarding any in-session drag edits — city sets are seed-derived, unlike free-form paths. */
  loadFromSeed(worldId: string): void {
    this.nodes = allCityNodes(worldId);
  }

  get(id: string): MapEditorCityNode | undefined {
    return this.nodes.find((n) => n.id === id);
  }

  /**
   * Id of the nearest city whose footprint box (grown by `radiusTiles`, the on-screen grab
   * tolerance converted to tile units) contains the point — or null if the click missed every
   * city. Distance is measured to the footprint's edge, not its center, so a large city is as easy
   * to grab anywhere on its plot as a small one is at its middle.
   */
  findNearest(t: TilePoint, radiusTiles: number): string | null {
    let best: { id: string; dist: number } | null = null;
    for (const node of this.nodes) {
      const half = node.footprint / 2;
      const dx = Math.max(0, Math.abs(t.x - node.x) - half);
      const dy = Math.max(0, Math.abs(t.y - node.y) - half);
      const dist = Math.hypot(dx, dy);
      if (dist <= radiusTiles && (!best || dist < best.dist)) best = { id: node.id, dist };
    }
    return best ? best.id : null;
  }

  toJSON(): string {
    return JSON.stringify(this.nodes, null, 2);
  }

  loadFromJSON(json: string): void {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error('expected an array of city nodes');
    for (const raw of parsed as MapEditorCityNode[]) {
      if (!['capital', 'worldCenter', 'garrison'].includes(raw.kind)) {
        throw new Error(`invalid city kind: ${String(raw.kind)}`);
      }
      if (typeof raw.x !== 'number' || typeof raw.y !== 'number') throw new Error('city node needs numeric x/y');
    }
    this.nodes = parsed as MapEditorCityNode[];
  }
}

/**
 * Keeps a dragged city's whole footprint on the map — the position is the plot's center, so the
 * clamp is inset by half the footprint on every side (the World Center's 9×9 plot keeps its shape
 * instead of being cropped at the map edge).
 */
export function clampCityPos(node: MapEditorCityNode, t: TilePoint): TilePoint {
  const half = Math.floor(node.footprint / 2);
  return {
    x: Math.max(half, Math.min(SLG_MAP_W - 1 - half, t.x)),
    y: Math.max(half, Math.min(SLG_MAP_H - 1 - half, t.y)),
  };
}
