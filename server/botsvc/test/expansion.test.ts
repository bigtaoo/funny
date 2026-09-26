// BOTSVC_DESIGN §3.4: which tile a bot marches on next. The planner is pure, so the rules are pinned here
// one at a time; bot.test.ts covers how BotSession paces and sends what it returns.
import { describe, it, expect } from 'vitest';
import { OCCUPY_MIN_TROOPS } from '@nw/shared';
import { EXPAND_MARCH_MIN_POOL, EXPAND_MAX_LEVEL, EXPAND_TROOP_FLOOR, planExpansion } from '../src/expansion';
import type { WorldTileView } from '../src/worldClient';

/** Base anchored at (10,10): its 3x3 footprint is x,y in 9..11, so x=12 / x=8 / y=12 / y=8 border it. */
const BASE = { x: 10, y: 10 };
const NOW = 1_000_000;
const RICH = 10_000;

const res = (x: number, y: number, over: Partial<WorldTileView> = {}): WorldTileView =>
  ({ x, y, type: 'resource', level: 1, resType: 'paper', ...over });
const enemy = (x: number, y: number, over: Partial<WorldTileView> = {}): WorldTileView =>
  ({ x, y, type: 'territory', level: 1, occupied: true, ...over });
const target = (tiles: WorldTileView[], troops = RICH, yieldRate: Record<string, number> = {}) => {
  const p = planExpansion(tiles, BASE, troops, NOW, yieldRate);
  return p && { kind: p.kind, x: p.x, y: p.y };
};

describe('planExpansion — what counts as connected (ADR-039)', () => {
  it('occupies a tile sharing an edge with the base footprint', () => {
    expect(target([res(12, 10)])).toEqual({ kind: 'occupy', x: 12, y: 10 });
  });

  it('ignores a tile two cells out, and one touching the footprint only at a corner', () => {
    // (12,12) meets (11,11) diagonally: iso drawing makes it LOOK adjacent, the server says no.
    expect(target([res(13, 10), res(12, 12)])).toBeNull();
  });

  it('grows from land it already holds, not only from the base', () => {
    expect(target([res(12, 10, { mine: true, occupied: true }), res(13, 10)])).toEqual({ kind: 'occupy', x: 13, y: 10 });
  });

  it('family and same-sect land extend the frontier; an allied sect\'s land does not', () => {
    const far = 30;
    expect(target([res(far, 0, { ally: true, occupied: true }), res(far + 1, 0)])).toEqual({ kind: 'occupy', x: far + 1, y: 0 });
    expect(target([res(far, 0, { sectmate: true, occupied: true }), res(far + 1, 0)])).toEqual({ kind: 'occupy', x: far + 1, y: 0 });
    expect(target([res(far, 0, { allySect: true, occupied: true }), res(far + 1, 0)])).toBeNull();
  });
});

describe('planExpansion — which tile to occupy', () => {
  it('only resource tiles up to EXPAND_MAX_LEVEL', () => {
    expect(EXPAND_MAX_LEVEL).toBe(2);
    expect(target([res(12, 10, { level: 3 })])).toBeNull();
    expect(target([res(12, 10, { level: 2 })])).toEqual({ kind: 'occupy', x: 12, y: 10 });
  });

  it('never a tile that is taken, being held by someone, or not a resource tile', () => {
    expect(target([
      res(12, 10, { occupied: true }),
      res(8, 10, { contestedUntil: NOW + 1 }),
      { x: 10, y: 12, type: 'obstacle', level: 1 },
      { x: 10, y: 8, type: 'familyKeep', level: 1 },
      { x: 12, y: 9, type: 'stronghold', level: 1 },
    ])).toBeNull();
  });

  it('an occupation hold that has already ended is fair game again', () => {
    expect(target([res(12, 10, { contestedUntil: NOW })])).toEqual({ kind: 'occupy', x: 12, y: 10 });
  });

  it('paper and graphite before any other resource, even at a higher level', () => {
    expect(target([res(12, 10, { resType: 'ink' }), res(8, 10, { resType: 'metal' }), res(10, 12, { resType: 'graphite', level: 2 })]))
      .toEqual({ kind: 'occupy', x: 10, y: 12 });
  });

  it('a resource it does not produce at all comes before everything else, paper/graphite included', () => {
    // Training costs all five: one missing input and no troop can ever be trained.
    const offer = [res(12, 10, { resType: 'paper' }), res(8, 10, { resType: 'metal', level: 2 })];
    expect(target(offer, RICH, { ink: 100, paper: 100 })).toEqual({ kind: 'occupy', x: 8, y: 10 });
    // Only an actual yield counts as produced; a 0 entry is as missing as an absent one.
    expect(target(offer, RICH, { ink: 100, paper: 100, metal: 0 })).toEqual({ kind: 'occupy', x: 8, y: 10 });
    // With nothing missing, paper/graphite first again.
    expect(target(offer, RICH, { ink: 100, paper: 100, metal: 100 })).toEqual({ kind: 'occupy', x: 12, y: 10 });
  });

  it('a fresh bot (base ink only) is missing all four, and still takes paper/graphite first among them', () => {
    const offer = [res(12, 10, { resType: 'metal' }), res(8, 10, { resType: 'ink' }), res(10, 12, { resType: 'graphite', level: 2 })];
    expect(target(offer, RICH, { ink: 100 })).toEqual({ kind: 'occupy', x: 10, y: 12 });
  });

  it('then the lower level, then the tile nearer the base', () => {
    expect(target([res(12, 10, { level: 2 }), res(12, 9, { level: 1 })])).toEqual({ kind: 'occupy', x: 12, y: 9 });
    // Same level: (12,10) is 2 from the anchor, (12,9) is 3.
    expect(target([res(12, 9), res(12, 10)])).toEqual({ kind: 'occupy', x: 12, y: 10 });
  });

  it('breaks exact ties by coordinates, so a bot does not flip between two equal tiles', () => {
    const a = res(12, 10);
    const b = res(8, 10);
    expect(target([a, b])).toEqual(target([b, a]));
  });

  it('sends exactly the server minimum, and only if EXPAND_TROOP_FLOOR stays home', () => {
    expect(EXPAND_MARCH_MIN_POOL).toBe(EXPAND_TROOP_FLOOR + OCCUPY_MIN_TROOPS);
    const tiles = [res(12, 10)];
    expect(planExpansion(tiles, BASE, EXPAND_TROOP_FLOOR + OCCUPY_MIN_TROOPS, NOW)).toEqual({ kind: 'occupy', x: 12, y: 10, troops: OCCUPY_MIN_TROOPS });
    expect(planExpansion(tiles, BASE, EXPAND_TROOP_FLOOR + OCCUPY_MIN_TROOPS - 1, NOW)).toBeNull();
  });
});

describe('planExpansion — attacking, only when there is nothing to occupy', () => {
  it('occupying wins over an adjacent enemy tile', () => {
    expect(target([enemy(12, 10), res(8, 10)])).toEqual({ kind: 'occupy', x: 8, y: 10 });
  });

  it('attacks an adjacent enemy territory tile when no occupation is left', () => {
    expect(target([enemy(12, 10), res(8, 10, { level: 3 })])).toEqual({ kind: 'attack', x: 12, y: 10 });
  });

  it('never an enemy two cells out, a protected tile, a base, or anyone friendly', () => {
    expect(target([
      enemy(13, 10),
      enemy(8, 10, { protectedUntil: NOW + 1 }),
      enemy(10, 12, { type: 'base' }),
      enemy(10, 8, { allySect: true }),
      enemy(12, 9, { ally: true }),
      enemy(12, 11, { sectmate: true }),
    ])).toBeNull();
  });

  it('sends 30% of the pool, at least OCCUPY_MIN_TROOPS, and never into the floor', () => {
    const tiles = [enemy(12, 10)];
    expect(planExpansion(tiles, BASE, 10_000, NOW)!.troops).toBe(3000);
    // 30% of 2800 is 840, but only 800 sit above the floor.
    expect(planExpansion(tiles, BASE, 2800, NOW)!.troops).toBe(800);
    expect(planExpansion(tiles, BASE, EXPAND_TROOP_FLOOR + OCCUPY_MIN_TROOPS, NOW)!.troops).toBe(OCCUPY_MIN_TROOPS);
    expect(planExpansion(tiles, BASE, EXPAND_TROOP_FLOOR + OCCUPY_MIN_TROOPS - 1, NOW)).toBeNull();
  });
});
