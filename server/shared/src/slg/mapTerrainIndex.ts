// Per-world terrain + connectivity index for march pathfinding (worldsvc-concurrency-2026-09-05, phase 1).
//
// Two problems this solves, both measured on the real 1500x1500 map (see
// design/game/WORLDSVC_CONCURRENCY_AUDIT_2026-09-05.md for the full table):
//
//   1. findMarchPath's `walkable()` calls `proceduralTile()` for every neighbour it considers — ~1.14us
//      each (ring/river/branch noise, a 54-node city scan and a 13-node capital scan, per call). At the
//      500k-node cap that is ~2M evaluations, i.e. seconds. Precomputing the classification into a
//      Uint8Array turns each of those into an array index.
//   2. The dominant worst case is not a long path, it is an UNREACHABLE target: rivers and mountain rings
//      cut the map into pieces joined only by bridges/plankways, which are passable only to whoever holds
//      them. A* has to exhaust its entire node budget to conclude "no path" — measured at 2-6 SECONDS of
//      blocked event loop, on a single ordinary occupy order. A connectivity check answers the same
//      question up front in microseconds.
//
// The connectivity answer is deliberately CONSERVATIVE and that is what makes it safe to short-circuit on:
// it accounts for terrain and gates only, not for enemy-base footprints or blocker structures, which can
// only ever REMOVE routes. So "not connected" is a proof of unreachability (short-circuit), while
// "connected" means "maybe" and still runs the real A*. No march that succeeds today starts failing.
//
// Pure and dependency-free (same constraint as the rest of slg/): this module is built to run inside a
// worker thread today and inside a standalone compute service later, neither of which has DB access.
import { proceduralTile } from './mapgen/tileGen';

/** Pathing classification of a cell. Mirrors findMarchPath's `walkable()` exactly — see the file header. */
export const TERRAIN_PASSABLE = 0;
export const TERRAIN_OBSTACLE = 1;
/** bridge/plankway: passable only when held by the marcher's faction, or when it is the destination. */
export const TERRAIN_CROSSING = 2;

/** Component id 0 is reserved for "no component" (obstacle or crossing cells); real ids start at 1. */
const NO_COMPONENT = 0;

/** Uint16Array ceiling for component ids. The real map produces single digits (pinned by test). */
const MAX_COMPONENTS = 65535;

export interface MapTerrainIndex {
  readonly world: string;
  readonly mapW: number;
  readonly mapH: number;
  /** TERRAIN_* per cell, row-major (`y * mapW + x`). */
  readonly terrain: Uint8Array;
  /** Connected-component id per passable cell (4-connected, crossings excluded); 0 elsewhere. */
  readonly component: Uint16Array;
  /** Number of distinct components (ids 1..componentCount). */
  readonly componentCount: number;
  /** Flat index of every crossing cell to the distinct component ids orthogonally adjacent to it. */
  readonly gates: Map<number, readonly number[]>;
  /** Wall-clock milliseconds the build took. Logged once at warmup; never used in a decision. */
  readonly buildMs: number;
}

/**
 * Build the index for one world. ~2.6s on a 1500x1500 map, dominated by the 2.25M `proceduralTile` calls —
 * which is precisely why callers must never do this on a request-serving thread. {@link getMapTerrainIndex}
 * caches per process; worldsvc warms it on the compute workers at boot.
 */
export function buildMapTerrainIndex(world: string, mapW: number, mapH: number): MapTerrainIndex {
  const t0 = Date.now();
  const n = mapW * mapH;
  const terrain = new Uint8Array(n);
  for (let y = 0; y < mapH; y++) {
    const row = y * mapW;
    for (let x = 0; x < mapW; x++) {
      const type = proceduralTile(world, x, y).type;
      terrain[row + x] =
        type === 'obstacle' ? TERRAIN_OBSTACLE
          : type === 'bridge' || type === 'plankway' ? TERRAIN_CROSSING
            : TERRAIN_PASSABLE;
    }
  }

  // 4-connected flood fill over passable cells. An explicit Int32Array stack rather than recursion: one
  // component spans most of a continent, so recursion would overflow long before it finished.
  const component = new Uint16Array(n);
  const stack = new Int32Array(n);
  let componentCount = 0;
  for (let seed = 0; seed < n; seed++) {
    if (terrain[seed] !== TERRAIN_PASSABLE || component[seed] !== NO_COMPONENT) continue;
    // Overflowing the Uint16 id space would make every cell past the cap read as "no component", i.e. as
    // NOT connected — conservative in the WRONG direction (a legal march refused), so it throws rather
    // than silently mis-answering. Unreachable on any map this game generates; here for the next one.
    if (componentCount >= MAX_COMPONENTS) throw new Error(`map ${world} exceeds ${MAX_COMPONENTS} terrain components`);
    const id = ++componentCount;
    let top = 0;
    stack[top++] = seed;
    component[seed] = id;
    while (top > 0) {
      const cur = stack[--top]!;
      const cx = cur % mapW;
      const cy = (cur / mapW) | 0;
      if (cx > 0) top = pushCell(stack, top, terrain, component, cur - 1, id);
      if (cx < mapW - 1) top = pushCell(stack, top, terrain, component, cur + 1, id);
      if (cy > 0) top = pushCell(stack, top, terrain, component, cur - mapW, id);
      if (cy < mapH - 1) top = pushCell(stack, top, terrain, component, cur + mapW, id);
    }
  }

  // Gate adjacency: which components each crossing cell would join if it were open. A crossing touching
  // another crossing chains through it, which the BFS in reachableThroughGates handles by hopping
  // gate-to-gate, so only real component ids are recorded here.
  const gates = new Map<number, readonly number[]>();
  for (let i = 0; i < n; i++) {
    if (terrain[i] !== TERRAIN_CROSSING) continue;
    const x = i % mapW;
    const y = (i / mapW) | 0;
    const adj: number[] = [];
    if (x > 0) addComponent(adj, component[i - 1]!);
    if (x < mapW - 1) addComponent(adj, component[i + 1]!);
    if (y > 0) addComponent(adj, component[i - mapW]!);
    if (y < mapH - 1) addComponent(adj, component[i + mapW]!);
    gates.set(i, adj);
  }

  return { world, mapW, mapH, terrain, component, componentCount, gates, buildMs: Date.now() - t0 };
}

function pushCell(stack: Int32Array, top: number, terrain: Uint8Array, component: Uint16Array, idx: number, id: number): number {
  if (terrain[idx] !== TERRAIN_PASSABLE || component[idx] !== NO_COMPONENT) return top;
  component[idx] = id;
  stack[top] = idx;
  return top + 1;
}

function addComponent(adj: number[], id: number): void {
  if (id !== NO_COMPONENT && !adj.includes(id)) adj.push(id);
}

/**
 * How many worlds one process keeps indexed. Each entry is ~6.75MB at 1500x1500 (2.25MB terrain +
 * 4.5MB components), and every compute worker holds its own copy, so this is bounded deliberately rather
 * than left to grow with the number of worlds a long-lived process has ever been asked about. Two active
 * shards plus headroom: a season rollover briefly has the old and the new world both in play.
 */
const INDEX_CACHE_MAX = 4;

// Insertion-ordered, used as an LRU: a hit re-inserts at the end, so the eviction victim is the world
// this process has gone longest without pathing in.
const indexCache = new Map<string, MapTerrainIndex>();

/** Process-local cached {@link buildMapTerrainIndex}. Keyed by world + map size, so a resized map rebuilds. */
export function getMapTerrainIndex(world: string, mapW: number, mapH: number): MapTerrainIndex {
  const key = `${world}|${mapW}|${mapH}`;
  const hit = indexCache.get(key);
  if (hit) {
    indexCache.delete(key);
    indexCache.set(key, hit);
    return hit;
  }
  const idx = buildMapTerrainIndex(world, mapW, mapH);
  indexCache.set(key, idx);
  while (indexCache.size > INDEX_CACHE_MAX) {
    const oldest = indexCache.keys().next();
    if (oldest.done) break;
    indexCache.delete(oldest.value);
  }
  return idx;
}

/** Drop cached indexes. Tests only — a worker builds each world once and keeps it for the process lifetime. */
export function clearMapTerrainIndexCache(): void {
  indexCache.clear();
}

/**
 * Conservative reachability: could a marcher standing on (fx,fy) reach (tx,ty) over terrain alone, given the
 * crossings they may pass? `false` is a PROOF of unreachability (safe to reject without running A*); `true`
 * means "not ruled out here" — enemy bases and blocker structures are not modelled, so A* still decides.
 *
 * This models `findMarchPath`'s walkability rules exactly, minus those blockers, which is what makes the
 * short-circuit sound. Three of those rules are easy to get wrong and each cost a real failure in the
 * equivalence test that guards this function (mapTerrainIndex.test.ts):
 *
 *   • The START cell is expanded unconditionally by A* — it never asks whether the marcher is standing
 *     somewhere legal. A base footprint or a re-dispatched field team can sit on a cell this index calls an
 *     obstacle or a crossing, and A* will still walk out of it. So a non-passable start seeds from whatever
 *     its neighbours allow, rather than answering "unreachable".
 *   • The DESTINATION is exempt from the gate rule (`walkable(_, isDest)`): you may march ONTO an enemy-held
 *     crossing to besiege it, you just may not march THROUGH it.
 *   • Crossings CHAIN. A two-cell bridge is two crossing cells touching each other and nothing else, so a
 *     model that only ever hops component→gate→component never reaches the far side.
 *
 * The search therefore runs over a graph with two kinds of node — terrain components and individual open
 * crossing cells — rather than over components alone.
 */
export function reachableThroughGates(
  idx: MapTerrainIndex,
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  passableGateKeys: ReadonlySet<string>,
): boolean {
  const { mapW, mapH, terrain, component, gates } = idx;
  if (fx < 0 || fy < 0 || fx >= mapW || fy >= mapH || tx < 0 || ty < 0 || tx >= mapW || ty >= mapH) return false;
  const from = fy * mapW + fx;
  const to = ty * mapW + tx;
  if (from === to) return true;
  if (terrain[to] === TERRAIN_OBSTACLE) return false; // obstacles block even as a destination

  const neighbours = (flat: number): number[] => {
    const x = flat % mapW;
    const y = (flat / mapW) | 0;
    const out: number[] = [];
    if (x > 0) out.push(flat - 1);
    if (x < mapW - 1) out.push(flat + 1);
    if (y > 0) out.push(flat - mapW);
    if (y < mapH - 1) out.push(flat + mapW);
    return out;
  };
  const isOpen = (flat: number): boolean => passableGateKeys.has(`${flat % mapW}:${(flat / mapW) | 0}`);

  // Target sitting right next to the start: A* steps straight onto it, whatever either cell is.
  if (neighbours(from).includes(to)) return true;

  // Seed the frontier with everything the marcher's first step can reach. For a passable start that is just
  // its own component; otherwise it is whatever its neighbours offer (see the START note above).
  const seenComponents = new Set<number>();
  const seenGates = new Set<number>();
  const componentQueue: number[] = [];
  const gateQueue: number[] = [];
  const enterComponent = (id: number): void => {
    if (id === NO_COMPONENT || seenComponents.has(id)) return;
    seenComponents.add(id);
    componentQueue.push(id);
  };
  const enterGate = (flat: number): void => {
    if (seenGates.has(flat)) return;
    seenGates.add(flat);
    gateQueue.push(flat);
  };
  if (terrain[from] === TERRAIN_PASSABLE) {
    enterComponent(component[from]!);
  } else {
    for (const n of neighbours(from)) {
      if (terrain[n] === TERRAIN_PASSABLE) enterComponent(component[n]!);
      else if (terrain[n] === TERRAIN_CROSSING && isOpen(n)) enterGate(n);
    }
  }
  // A crossing start is itself a cell the marcher already occupies, so its own onward links count too.
  if (terrain[from] === TERRAIN_CROSSING) enterGate(from);

  // Acceptance: a passable target is reached by reaching its component; a crossing target is reached by
  // standing anywhere orthogonally next to it (destination exemption), i.e. by touching one of its
  // components or by reaching an open crossing beside it.
  const targetComponent = terrain[to] === TERRAIN_PASSABLE ? component[to]! : NO_COMPONENT;
  const targetTouchingComponents = terrain[to] === TERRAIN_CROSSING ? new Set(gates.get(to) ?? []) : null;
  const targetNeighbours = terrain[to] === TERRAIN_CROSSING ? new Set(neighbours(to)) : null;
  const accepts = (comp: number): boolean =>
    (targetComponent !== NO_COMPONENT && comp === targetComponent) || !!targetTouchingComponents?.has(comp);

  for (const c of seenComponents) if (accepts(c)) return true;
  for (const g of seenGates) if (targetNeighbours?.has(g)) return true;

  // Alternating BFS over the two node kinds. Both frontiers are tiny — a handful of components and, on the
  // real map, 75 crossings in total — so this stays in the microseconds however large the map is.
  const byComponent = gatesByComponent(idx);
  while (componentQueue.length > 0 || gateQueue.length > 0) {
    while (componentQueue.length > 0) {
      const comp = componentQueue.shift()!;
      for (const gate of byComponent.get(comp) ?? []) {
        if (!isOpen(gate)) continue;
        if (targetNeighbours?.has(gate)) return true;
        enterGate(gate);
      }
    }
    while (gateQueue.length > 0) {
      const gate = gateQueue.shift()!;
      for (const n of neighbours(gate)) {
        if (n === to) return true; // stepped straight onto the destination
        if (terrain[n] === TERRAIN_PASSABLE) {
          const comp = component[n]!;
          if (accepts(comp)) return true;
          enterComponent(comp);
        } else if (terrain[n] === TERRAIN_CROSSING && isOpen(n)) {
          enterGate(n); // crossings chain (see the CHAIN note above)
        }
      }
    }
  }
  return false;
}

const gatesByComponentCache = new WeakMap<MapTerrainIndex, Map<number, number[]>>();

/** Reverse of `gates`: component id to the crossing cells touching it. Built once per index, on first query. */
function gatesByComponent(idx: MapTerrainIndex): Map<number, number[]> {
  let m = gatesByComponentCache.get(idx);
  if (m) return m;
  m = new Map<number, number[]>();
  for (const [gate, comps] of idx.gates) {
    for (const c of comps) {
      const list = m.get(c);
      if (list) list.push(gate);
      else m.set(c, [gate]);
    }
  }
  gatesByComponentCache.set(idx, m);
  return m;
}
