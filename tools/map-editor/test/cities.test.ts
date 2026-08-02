// CityStore — the city-drag tool's data model (DESIGN.md §6.1 third bullet). Positions seed from
// the generator and are then mutated in place by dragging, so the assertions that matter are:
// the seed load is deterministic, in-place edits survive, and import validates before replacing.
import { describe, expect, it } from 'vitest';
import { SLG_MAP_H, SLG_MAP_W, type MapEditorCityNode } from '@nw/shared/slg';
import { clampCityPos, CityStore } from '../src/state/cities';

function node(over: Partial<MapEditorCityNode> = {}): MapEditorCityNode {
  return { id: 'n', kind: 'garrison', x: 100, y: 100, level: 5, footprint: 5, ...over };
}

describe('CityStore.loadFromSeed', () => {
  it('is deterministic for a given worldId', () => {
    const a = new CityStore();
    const b = new CityStore();
    a.loadFromSeed('preview');
    b.loadFromSeed('preview');
    expect(b.toJSON()).toBe(a.toJSON());
  });

  it('produces different layouts for different worldIds', () => {
    const a = new CityStore();
    const b = new CityStore();
    a.loadFromSeed('preview');
    b.loadFromSeed('some-other-world');
    expect(b.toJSON()).not.toBe(a.toJSON());
  });

  it('yields exactly one world center plus capitals and garrisons, all in bounds', () => {
    const s = new CityStore();
    s.loadFromSeed('preview');
    expect(s.nodes.length).toBeGreaterThan(0);
    expect(s.nodes.filter((n) => n.kind === 'worldCenter')).toHaveLength(1);
    expect(s.nodes.some((n) => n.kind === 'capital')).toBe(true);
    expect(s.nodes.some((n) => n.kind === 'garrison')).toBe(true);
    for (const n of s.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThan(SLG_MAP_W);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThan(SLG_MAP_H);
      expect(n.footprint).toBeGreaterThan(0);
    }
  });

  it('gives every node a unique id (get() and selection key off it)', () => {
    const s = new CityStore();
    s.loadFromSeed('preview');
    expect(new Set(s.nodes.map((n) => n.id)).size).toBe(s.nodes.length);
  });

  it('discards in-session drag edits — city sets are seed-derived, unlike the free-form terrain grid', () => {
    const s = new CityStore();
    s.loadFromSeed('preview');
    const before = s.nodes[0]!.x;
    s.nodes[0]!.x = before + 25;
    s.loadFromSeed('preview');
    expect(s.nodes[0]!.x).toBe(before);
  });
});

describe('CityStore.get', () => {
  it('returns the live node object, so a drag mutates the stored city', () => {
    const s = new CityStore();
    s.loadFromSeed('preview');
    const id = s.nodes[3]!.id;
    const node = s.get(id)!;
    node.x = 42;
    expect(s.nodes[3]!.x).toBe(42);
  });

  it('returns undefined for an unknown id', () => {
    const s = new CityStore();
    s.loadFromSeed('preview');
    expect(s.get('no-such-city')).toBeUndefined();
  });
});

describe('CityStore.findNearest', () => {
  // The City tool's hit-test. Distance is to the footprint EDGE, so a 9×9 world center is grabbable
  // anywhere on its plot rather than only near its center pixel.
  const store = new CityStore();
  store.nodes = [
    node({ id: 'small', x: 100, y: 100, footprint: 3 }),
    node({ id: 'big', x: 200, y: 100, footprint: 9 }),
  ];

  it('hits a city clicked at its center', () => {
    expect(store.findNearest({ x: 100, y: 100 }, 0.1)).toBe('small');
  });

  it('hits anywhere inside the footprint, even with a zero grab radius', () => {
    expect(store.findNearest({ x: 204, y: 104 }, 0)).toBe('big');
    expect(store.findNearest({ x: 196, y: 96 }, 0)).toBe('big');
  });

  it('misses just outside the footprint plus the grab radius', () => {
    // 'big' spans ±4.5 tiles; 200+4.5+1 = 205.5 is 1 tile clear of the edge.
    expect(store.findNearest({ x: 206.5, y: 100 }, 1)).toBeNull();
    expect(store.findNearest({ x: 206.5, y: 100 }, 2)).toBe('big');
  });

  it('returns null when the click is nowhere near a city', () => {
    expect(store.findNearest({ x: 500, y: 500 }, 5)).toBeNull();
  });

  it('picks the closer of two candidates in range', () => {
    const pair = new CityStore();
    pair.nodes = [node({ id: 'far', x: 100, y: 100, footprint: 1 }), node({ id: 'near', x: 106, y: 100, footprint: 1 })];
    expect(pair.findNearest({ x: 105, y: 100 }, 10)).toBe('near');
  });

  it('finds nothing in an empty store', () => {
    expect(new CityStore().findNearest({ x: 0, y: 0 }, 100)).toBeNull();
  });

  it('grabs real generated cities at their own coordinates', () => {
    const s = new CityStore();
    s.loadFromSeed('preview');
    for (const n of s.nodes.slice(0, 10)) {
      expect(s.findNearest({ x: n.x, y: n.y }, 0)).not.toBeNull();
    }
  });
});

describe('clampCityPos', () => {
  it('leaves a city in the map interior alone', () => {
    expect(clampCityPos(node({ footprint: 5 }), { x: 700, y: 700 })).toEqual({ x: 700, y: 700 });
  });

  it('keeps the whole footprint on the map at the top-left corner', () => {
    expect(clampCityPos(node({ footprint: 9 }), { x: 0, y: 0 })).toEqual({ x: 4, y: 4 });
  });

  it('keeps the whole footprint on the map at the bottom-right corner', () => {
    const p = clampCityPos(node({ footprint: 9 }), { x: SLG_MAP_W + 50, y: SLG_MAP_H + 50 });
    expect(p).toEqual({ x: SLG_MAP_W - 5, y: SLG_MAP_H - 5 });
  });

  it('insets by half the footprint — a bigger city is held further from the edge', () => {
    const small = clampCityPos(node({ footprint: 3 }), { x: 0, y: 0 });
    const big = clampCityPos(node({ footprint: 9 }), { x: 0, y: 0 });
    expect(big.x).toBeGreaterThan(small.x);
  });

  it('clamps each axis independently', () => {
    expect(clampCityPos(node({ footprint: 5 }), { x: -20, y: 800 })).toEqual({ x: 2, y: 800 });
  });
});

describe('CityStore JSON round-trip', () => {
  it('export → import reproduces the node list, including dragged positions', () => {
    const a = new CityStore();
    a.loadFromSeed('preview');
    a.nodes[1]!.x = 123;
    a.nodes[1]!.y = 456;

    const b = new CityStore();
    b.loadFromJSON(a.toJSON());
    expect(b.nodes).toEqual(a.nodes);
    expect(b.nodes[1]!.x).toBe(123);
  });

  it('rejects malformed input instead of replacing the node list with garbage', () => {
    const s = new CityStore();
    s.loadFromSeed('preview');
    const before = s.nodes.length;

    expect(() => s.loadFromJSON('{}')).toThrow(/expected an array/);
    expect(() => s.loadFromJSON('[{"kind":"village","x":1,"y":1}]')).toThrow(/invalid city kind/);
    expect(() => s.loadFromJSON('[{"kind":"capital","x":"1","y":1}]')).toThrow(/numeric x\/y/);

    expect(s.nodes).toHaveLength(before); // validation runs before the swap — nothing was clobbered
  });

  it('accepts an empty list', () => {
    const s = new CityStore();
    s.loadFromSeed('preview');
    s.loadFromJSON('[]');
    expect(s.nodes).toEqual([]);
  });
});
