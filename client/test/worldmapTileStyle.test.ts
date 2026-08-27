// Unit coverage for the world map's tile-styling layer (src/scenes/worldmap/logic/tileStyle.ts), brought
// into the measured suite by ADR-071 4b (2026-08-27).
//
// Why this file is worth having rather than "it's just colour constants": the module encodes two rules the
// art direction leans on, and both fail SILENTLY when broken — a wrong colour still renders.
//
//   1. **Ownership is the only strong colour, and its priority order is the server's** (ADR-003's iron rule
//      + worldsvc core/map.ts's mutually-exclusive tagging). `ownerTint` reads five flags that the server
//      sets exclusively but the type system lets a caller set together; if its order drifts from the
//      server's, a sect-mate's land can render enemy-red — which is exactly the gap ADR-024's correction
//      note describes, before SECT_TINT/ALLY_SECT_TINT existed.
//   2. **Terrain never masquerades as ownership.** The terrain/resource palettes are deliberately
//      paper-adjacent; a saturated value slipping into one of them turns the map into the "彩色纸屑"
//      confetti the 2026-07-08 pass already fixed once. Asserted as a SATURATION bound rather than as a
//      list of hex values, so a retune inside the intended range stays free while a red/blue/green
//      terrain fill fails.
//
// Deliberately NOT here: `drawTileL1`/`drawTileL2` and the ownership-border geometry — those need PIXI and
// live in test/ui/worldMapOwnerBorder.ui.ts, which is where they belong.
import { describe, it, expect } from 'vitest';
import { proceduralTile, biomeMixAt, worldSeed, SLG_MAP_W, SLG_MAP_H, type ObstacleKind } from '@nw/shared';
import {
  TERRAIN_COLORS,
  RES_COLORS,
  RES_TEX_TINT,
  TERRAIN_TEX_ALPHA,
  TERRAIN_TEX_ALPHA_DEFAULT,
  TERRAIN_TEX_TINT,
  TERRAIN_TEX_TINT_DEFAULT,
  MINE_TINT,
  MINE_BASE_TINT,
  ALLY_TINT,
  ALLY_BASE_TINT,
  SECT_TINT,
  SECT_BASE_TINT,
  ALLY_SECT_TINT,
  ALLY_SECT_BASE_TINT,
  ENEMY_TINT,
  ENEMY_BASE_TINT,
  ownerTint,
  terrainFill,
  terrainTextureName,
  obstacleTextureName,
  tileColor,
  proceduralTileColor,
  biomeGroundTint,
} from '../src/scenes/worldmap/logic/tileStyle';
import type { WorldTileView } from '../src/net/WorldApiClient';

const tile = (over: Partial<WorldTileView> = {}): WorldTileView =>
  ({ x: 0, y: 0, type: 'territory', ...over }) as WorldTileView;

/** HSV saturation of a packed 0xRRGGBB colour, 0..1. */
function saturation(hex: number): number {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}
/** HSV value (brightness) of a packed colour, 0..1. */
const value = (hex: number): number => Math.max((hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff) / 255;

describe('tileStyle: ownership tint priority mirrors the server tagging order', () => {
  // The order the server applies (worldsvc core/map.ts getMap): self > family ally > sect-mate >
  // allied-sect > any other occupier. Each row sets EVERY higher-priority flag off and this one on, plus
  // all the LOWER ones on — so a wrong order shows up as the lower flag winning.
  const ROWS: Array<[string, Partial<WorldTileView>, number, number]> = [
    ['mine',     { mine: true, ally: true, sectmate: true, allySect: true, occupied: true }, MINE_TINT, MINE_BASE_TINT],
    ['ally',     { ally: true, sectmate: true, allySect: true, occupied: true },             ALLY_TINT, ALLY_BASE_TINT],
    ['sectmate', { sectmate: true, allySect: true, occupied: true },                         SECT_TINT, SECT_BASE_TINT],
    ['allySect', { allySect: true, occupied: true },                                         ALLY_SECT_TINT, ALLY_SECT_BASE_TINT],
    ['enemy',    { occupied: true },                                                         ENEMY_TINT, ENEMY_BASE_TINT],
  ];

  for (const [name, flags, plain, base] of ROWS) {
    it(`${name} wins over every lower-priority flag, and its capital gets the deep variant`, () => {
      expect(ownerTint(tile({ ...flags, type: 'territory' })), `${name} territory`).toBe(plain);
      expect(ownerTint(tile({ ...flags, type: 'base' })), `${name} capital`).toBe(base);
    });
  }

  it('returns null for an unowned tile — that is what makes terrain the fallback', () => {
    expect(ownerTint(tile())).toBeNull();
    expect(ownerTint(tile({ type: 'resource', resType: 'ink' }))).toBeNull();
  });

  it('every capital tint is DARKER than its territory tint (the "deep ink" pairing)', () => {
    // Not decoration: the capital marker is read at a glance against a field of its own territory, so the
    // pair has to differ in brightness, not only in hue.
    for (const [name, , plain, base] of ROWS) {
      expect(value(base), `${name} capital vs territory brightness`).toBeLessThan(value(plain));
    }
  });

  it('the five ownership hues are all distinct — no two factions share a colour', () => {
    const all = ROWS.flatMap(([, , plain, base]) => [plain, base]);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('tileStyle: terrain never masquerades as ownership', () => {
  it('ownership tints are saturated and terrain/resource fills are not', () => {
    // The one structural property the palette rests on. Bounds rather than hex values so a retune inside
    // the intended range is free.
    for (const [name, hex] of Object.entries(TERRAIN_COLORS)) {
      expect(saturation(hex), `TERRAIN_COLORS.${name} saturation`).toBeLessThan(0.35);
    }
    for (const [name, hex] of Object.entries(RES_COLORS)) {
      expect(saturation(hex), `RES_COLORS.${name} saturation`).toBeLessThan(0.15);
      expect(value(hex), `RES_COLORS.${name} brightness`).toBeGreaterThan(0.85);
    }
    for (const t of [MINE_TINT, ALLY_TINT, SECT_TINT, ENEMY_TINT]) {
      expect(saturation(t)).toBeGreaterThan(0.2);
    }
  });

  it('the resource ground tints stay high-luminance (they multiply into grey pencil art)', () => {
    // PixiJS multiplies these into a luminance-mask texture, so a dark tint turns the tile into a colour
    // block and loses the hand-drawn linework — the failure the 2026-07-11 revert was about.
    for (const [name, hex] of Object.entries(RES_TEX_TINT)) {
      expect(value(hex), `RES_TEX_TINT.${name}`).toBeGreaterThan(0.7);
    }
  });

  it('texture alpha and tint overrides only ever soften, never brighten past the default', () => {
    for (const [name, a] of Object.entries(TERRAIN_TEX_ALPHA)) {
      expect(a!, `TERRAIN_TEX_ALPHA.${name}`).toBeLessThanOrEqual(TERRAIN_TEX_ALPHA_DEFAULT);
      expect(a!, `TERRAIN_TEX_ALPHA.${name}`).toBeGreaterThan(0.5);
    }
    // 0xffffff is "no tint"; every override must therefore be at or below it on all channels.
    for (const [name, hex] of Object.entries(TERRAIN_TEX_TINT)) {
      expect(value(hex), `TERRAIN_TEX_TINT.${name}`).toBeLessThan(value(TERRAIN_TEX_TINT_DEFAULT));
    }
  });
});

describe('tileStyle: fills and texture names', () => {
  it('terrainFill keys off resType for a resource tile and off type otherwise', () => {
    expect(terrainFill(tile({ type: 'resource', resType: 'ink' }))).toBe(RES_COLORS.ink);
    expect(terrainFill(tile({ type: 'obstacle' }))).toBe(TERRAIN_COLORS.obstacle);
    // A resource tile whose resType never arrived falls back to the resource fill, not to neutral.
    expect(terrainFill(tile({ type: 'resource' }))).toBe(TERRAIN_COLORS.resource);
    // An unknown type falls back to neutral rather than to `undefined` (which PIXI would draw as black).
    expect(terrainFill(tile({ type: 'no-such-terrain' as WorldTileView['type'] }))).toBe(TERRAIN_COLORS.neutral);
    expect(terrainFill(tile({ type: 'resource', resType: 'no-such-res' as never }))).toBe(TERRAIN_COLORS.resource);
  });

  it('tileColor prefers ownership and falls back to terrain', () => {
    expect(tileColor(tile({ mine: true }))).toBe(MINE_TINT);
    expect(tileColor(tile({ type: 'obstacle' }))).toBe(TERRAIN_COLORS.obstacle);
  });

  it('crossings render the terrain they SPAN, not a bridge-coloured ground', () => {
    // The building sprite is drawn on top by another layer; the ground has to read as the river/mountain
    // the crossing sits over, or a bridge looks like it is floating on grass.
    expect(terrainTextureName('bridge', 0, 0)).toBe('terrain_river');
    expect(terrainTextureName('plankway', 0, 0)).toBe('terrain_mountain');
  });

  it('an explicit obstacle kind is honoured verbatim; without one, the variant is a stable per-tile hash', () => {
    expect(terrainTextureName('obstacle', 3, 7, 'river')).toBe('terrain_river');
    expect(terrainTextureName('obstacle', 3, 7, 'mountain')).toBe('terrain_mountain');
    // Deterministic (same tile → same variant every call) and not constant across the map.
    const at = (x: number, y: number) => terrainTextureName('obstacle', x, y);
    expect(at(3, 7)).toBe(at(3, 7));
    const variants = new Set<string>();
    for (let i = 0; i < 20; i++) variants.add(at(i, 0));
    expect(variants.size, 'a legacy obstacle band must not be monotone').toBe(2);
  });

  it('maps the remaining named terrains, and defaults everything else to grass', () => {
    expect(terrainTextureName('familyKeep', 0, 0)).toBe('terrain_keep');
    expect(terrainTextureName('center', 0, 0)).toBe('terrain_center');
    expect(terrainTextureName('stronghold', 0, 0)).toBe('terrain_stronghold');
    for (const t of ['neutral', 'territory', 'base', 'resource', 'anything-else']) {
      expect(terrainTextureName(t, 0, 0), t).toBe('terrain_grass');
    }
  });

  it('obstacleTextureName is total over ObstacleKind and agrees with the hashed variant it replaces', () => {
    for (const kind of ['river', 'mountain'] as ObstacleKind[]) {
      expect(obstacleTextureName(kind)).toBe(terrainTextureName('obstacle', 0, 0, kind));
    }
  });
});

describe('tileStyle: procedural fallbacks', () => {
  it('proceduralTileColor agrees with terrainFill on the same generated tile', () => {
    // The two exist because a cell may or may not be in the tile cache; if they disagreed, a tile would
    // visibly change colour the moment its server row arrived.
    const W = 's1-tilestyle';
    for (let i = 0; i < 60; i++) {
      const x = 100 + i * 3;
      const y = 140 + ((i * 7) % 40);
      const p = proceduralTile(W, x, y);
      const asCached = terrainFill(tile({ type: p.type, ...(p.resType ? { resType: p.resType } : {}) }));
      expect(proceduralTileColor(W, x, y), `${x},${y} (${p.type}/${p.resType ?? '-'})`).toBe(asCached);
    }
  });

  it('biomeGroundTint returns a real RES_TEX_TINT entry for every cell it is asked about', () => {
    // The `mix.t === 0` branch is the only live one today (biomeMixAt never cross-fades), so the risk is
    // an unmapped resource key returning undefined — which PIXI would multiply as black.
    const seed = worldSeed('s1-tilestyle');
    const tints = new Set(Object.values(RES_TEX_TINT));
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const x = (i * 13) % SLG_MAP_W;
      const y = (i * 29) % SLG_MAP_H;
      const got = biomeGroundTint(x, y, seed);
      expect(Number.isFinite(got), `${x},${y}`).toBe(true);
      expect(tints.has(got), `${x},${y} -> ${got.toString(16)}`).toBe(true);
      seen.add(got);
    }
    // ...and the province leaning actually varies, or this assertion would be vacuous.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('biomeGroundTint is a pure function of (x, y, seed)', () => {
    const seed = worldSeed('s1-tilestyle');
    expect(biomeGroundTint(120, 130, seed)).toBe(biomeGroundTint(120, 130, seed));
    expect(biomeMixAt(120, 130, seed).t).toBe(0); // documents the "second branch is dead today" note
  });
});
