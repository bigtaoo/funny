// Editor-side city node state (DESIGN.md §6.1 third bullet + §6.2 point-node data form).
// Positions start from the generator's `allCityNodes(worldId)` output and are mutated in place by
// dragging — this module holds/mutates that state; rendering and input wiring live in index.ts.
import { allCityNodes, type MapEditorCityNode } from '@nw/shared/slg';

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

  toJSON(): string {
    return JSON.stringify(this.nodes, null, 2);
  }

  loadFromJSON(json: string): void {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error('expected an array of city nodes');
    for (const raw of parsed as MapEditorCityNode[]) {
      if (!['capital', 'gateCity', 'worldCenter', 'garrison'].includes(raw.kind)) {
        throw new Error(`invalid city kind: ${String(raw.kind)}`);
      }
      if (typeof raw.x !== 'number' || typeof raw.y !== 'number') throw new Error('city node needs numeric x/y');
    }
    this.nodes = parsed as MapEditorCityNode[];
  }
}
