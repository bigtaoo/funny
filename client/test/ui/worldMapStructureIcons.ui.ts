// Coverage for the 2026-08-09 UI fix: `tile.structure` (arrowTower / blocker) and
// `tile.watchtower` both got flagged as "wrong-looking icon" — see
// design/product/slg-building-art.md. The fix wires the blocker branch to try
// `placeBuildingSprite(g, 'icon_blocker', ...)` first (same pattern watchtower already
// used), falling back to the original geometric X-brace marker until the art actually
// exists. This suite locks in the geometric fallback path (which is all that runs in this
// test env — the building atlas is never loaded here, so isBuildingAtlasReady() is false
// and placeBuildingSprite always returns false) so the atlas-sprite wiring can't silently
// have dropped or altered the existing marker for anyone still on the fallback.
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { drawTileL1 } from '../../src/scenes/worldmap/tileGraphics';
import type { WorldTileView } from '../../src/net/WorldApiClient';

function spyBeginFill(g: PIXI.Graphics): { color: number; alpha: number }[] {
  const calls: { color: number; alpha: number }[] = [];
  vi.spyOn(g, 'beginFill').mockImplementation(function (this: PIXI.Graphics, color?, alpha?: number) {
    calls.push({ color: Number(color ?? 0), alpha: Number(alpha ?? 1) });
    return this;
  });
  return calls;
}
function spyLineStyle(g: PIXI.Graphics): { width: number; color: number; alpha: number }[] {
  const calls: { width: number; color: number; alpha: number }[] = [];
  vi.spyOn(g, 'lineStyle').mockImplementation(function (
    this: PIXI.Graphics, width?, color?: any, alpha?: any,
  ) {
    calls.push({ width: Number(width ?? 0), color: Number(color ?? 0), alpha: Number(alpha ?? 1) });
    return this;
  });
  return calls;
}
function spyMoveLine(g: PIXI.Graphics): { moves: [number, number][]; lines: [number, number][] } {
  const moves: [number, number][] = [];
  const lines: [number, number][] = [];
  vi.spyOn(g, 'moveTo').mockImplementation(function (this: PIXI.Graphics, x: number, y: number) {
    moves.push([x, y]); return this;
  });
  vi.spyOn(g, 'lineTo').mockImplementation(function (this: PIXI.Graphics, x: number, y: number) {
    lines.push([x, y]); return this;
  });
  return { moves, lines };
}

const TP = 76; // L1 tile pitch

function baseTile(extra: Partial<WorldTileView> = {}): WorldTileView {
  return { x: 5, y: 5, type: 'territory', level: 1, ...extra } as WorldTileView;
}

describe('drawTileL1 structure/watchtower markers — geometric fallback (2026-08-09 icon_blocker wiring)', () => {
  it('a blocker structure still draws the X-brace fallback (rect + two crossing braces) when the building atlas is not ready', () => {
    const g = new PIXI.Graphics();
    const beginFills = spyBeginFill(g);
    const lineStyles = spyLineStyle(g);
    const { moves, lines } = spyMoveLine(g);
    const tile = baseTile({ mine: true, structure: { kind: 'blocker', level: 1 } as WorldTileView['structure'] });

    drawTileL1(g, tile, 0xffffff, 0x4477cc, false, TP, false, 'terrain_grass', null, 5, 5, 'w1');

    // Fence-rail rect fill (fixed cream color, not ownership-tinted).
    expect(beginFills.some((f) => f.color === 0xe8dcc0 && f.alpha === 0.9)).toBe(true);
    // Two X-brace strokes tinted by the tile's ownership class (mine → blue).
    expect(lineStyles.some((l) => l.width === 1.5 && l.color === 0x4477cc)).toBe(true);
    expect(moves.length).toBeGreaterThanOrEqual(2);
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it("a blocker on enemy territory tints the X-brace red, not the owner's own colors", () => {
    const g = new PIXI.Graphics();
    const lineStyles = spyLineStyle(g);
    const tile = baseTile({ structure: { kind: 'blocker', level: 1 } as WorldTileView['structure'] }); // no mine/ally/sectmate/allySect
    drawTileL1(g, tile, 0xffffff, 0xcc3333, false, TP, false, 'terrain_grass', null, 5, 5, 'w1');
    expect(lineStyles.some((l) => l.color === 0xcc3333)).toBe(true);
    expect(lineStyles.some((l) => l.color === 0x4477cc)).toBe(false);
  });

  it('an arrowTower structure keeps drawing its own pointed-roof marker, untouched by the icon_blocker fallback branch', () => {
    const g = new PIXI.Graphics();
    const beginFills = spyBeginFill(g);
    const tile = baseTile({ mine: true, structure: { kind: 'arrowTower', level: 1 } as WorldTileView['structure'] });
    drawTileL1(g, tile, 0xffffff, 0x4477cc, false, TP, false, 'terrain_grass', null, 5, 5, 'w1');
    // Ownership-tinted roof fill (arrowTower's own branch, not the blocker rect color).
    expect(beginFills.some((f) => f.color === 0x4477cc)).toBe(true);
    expect(beginFills.some((f) => f.color === 0xe8dcc0)).toBe(true); // tower body, same as before
  });

  it('a watchtower still draws its geometric fallback tower (unrelated to the structure branch) when the atlas is not ready', () => {
    const g = new PIXI.Graphics();
    const beginFills = spyBeginFill(g);
    const tile = baseTile({ watchtower: true });
    drawTileL1(g, tile, 0xffffff, 0x888888, false, TP, false, 'terrain_grass', null, 5, 5, 'w1');
    expect(beginFills.some((f) => f.color === 0xe8dcc0)).toBe(true); // tower body
    expect(beginFills.some((f) => f.color === 0x4a3520)).toBe(true); // roof + arrow-slit ink color
  });

  it('a tile with neither structure nor watchtower draws none of these markers', () => {
    const g = new PIXI.Graphics();
    const beginFills = spyBeginFill(g);
    const tile = baseTile();
    drawTileL1(g, tile, 0xffffff, 0x888888, false, TP, false, 'terrain_grass', null, 5, 5, 'w1');
    expect(beginFills.some((f) => f.color === 0xe8dcc0)).toBe(false);
  });
});

// ── Atlas-sprite path: on-screen footprint (2026-08-15 "乱糟糟" fix) ─────────────────
// The suite above only exercises the geometric fallback. These lock the SPRITE branch's
// size, which is the thing that actually broke: a player can line up watchtowers/blockers
// on adjacent tiles, and under the 2:1 iso projection two neighbours' anchors are only
// TP/2 apart on screen — so a sprite much wider than that buries its neighbours and a
// defensive line renders as one unreadable hatch blob instead of N countable buildings.
describe('drawTileL1 structure/watchtower markers — atlas sprite footprint', () => {
  /** A texture of the given packed-frame size; never rendered, so no GL context is needed. */
  function fakeTex(w: number, h: number): PIXI.Texture {
    return new PIXI.Texture(new PIXI.BaseTexture(undefined, { width: w, height: h }));
  }

  /** Draw `tile` with the building atlas reporting ready, and return the sprites it added. */
  async function spritesFor(
    tile: WorldTileView, texW: number, texH: number, fogged = false,
  ): Promise<PIXI.Sprite[]> {
    vi.resetModules();
    vi.doMock('../../src/render/atlas/buildingAtlasLoader', () => ({
      isBuildingAtlasReady: () => true,
      getBuildingTexture: () => fakeTex(texW, texH),
    }));
    const { drawTileL1: draw } = await import('../../src/scenes/worldmap/tileGraphics');
    const g = new PIXI.Graphics();
    draw(g, tile, 0xffffff, 0x4477cc, fogged, TP, false, 'terrain_grass', null, 5, 5, 'w1');
    return g.children.filter((c): c is PIXI.Sprite => c instanceof PIXI.Sprite);
  }

  /** The structure sprite is added after any resource motif, so it is the last one. */
  async function spriteFor(tile: WorldTileView, texW: number, texH: number): Promise<PIXI.Sprite> {
    const sprites = await spritesFor(tile, texW, texH);
    return sprites[sprites.length - 1]!;
  }

  const blockerTile = (): WorldTileView =>
    baseTile({ mine: true, structure: { kind: 'blocker', level: 1 } as WorldTileView['structure'] });

  // TP/2 is the x-distance between two diagonally adjacent tiles' anchors; allow ~30% spill
  // (iso art is expected to lean on its neighbours a little, just not to swallow them).
  const MAX_W = TP * 0.7;

  it('the watchtower sprite stays within ~one neighbour spacing wide (256×198 frame)', async () => {
    const sp = await spriteFor(baseTile({ watchtower: true }), 256, 198);
    expect(sp.width).toBeGreaterThan(0);
    expect(sp.width).toBeLessThanOrEqual(MAX_W);
  });

  it('the blocker sprite stays within ~one neighbour spacing wide (256×88 frame)', async () => {
    const sp = await spriteFor(blockerTile(), 256, 88);
    expect(sp.width).toBeGreaterThan(0);
    expect(sp.width).toBeLessThanOrEqual(MAX_W);
  });

  it('scales both sprites purely from the tile pitch, so zooming keeps the same footprint ratio', async () => {
    // Guards against anyone "fixing" a size complaint with a pixel constant: the two coefficients
    // are fractions of tp, so the width/tp ratio has to be identical at any tile size.
    vi.resetModules();
    vi.doMock('../../src/render/atlas/buildingAtlasLoader', () => ({
      isBuildingAtlasReady: () => true,
      getBuildingTexture: () => fakeTex(256, 198),
    }));
    const { drawTileL1: draw } = await import('../../src/scenes/worldmap/tileGraphics');
    const widthAt = (tp: number): number => {
      const g = new PIXI.Graphics();
      draw(g, baseTile({ watchtower: true }), 0xffffff, 0x4477cc, false, tp, false, 'terrain_grass', null, 5, 5, 'w1');
      return (g.children.find((c): c is PIXI.Sprite => c instanceof PIXI.Sprite))!.width;
    };
    expect(widthAt(152) / 152).toBeCloseTo(widthAt(76) / 76, 5);
  });

  it('anchors both sprites bottom-center inside the diamond, so they stand on the tile', async () => {
    const hh = (TP * 0.5) / 2; // diamond half-height (ISO_RATIO = 0.5)
    for (const [tile, w, h] of [
      [baseTile({ watchtower: true }), 256, 198],
      [blockerTile(), 256, 88],
    ] as const) {
      const sp = await spriteFor(tile, w, h);
      expect(sp.anchor.x).toBe(0.5);
      expect(sp.anchor.y).toBe(1);        // bottom edge is the ground line
      expect(sp.x).toBe(0);               // centered on the diamond's center
      expect(sp.y).toBeGreaterThan(0);    // below center, i.e. toward the lower vertex
      expect(sp.y).toBeLessThan(hh);      // but not past it — never floats off the tile
    }
  });

  it('draws no watchtower/blocker sprite under fog — both are dynamic-layer state', async () => {
    // Terrain (ground texture, landmark buildings) survives fog; who built what does not.
    expect(await spritesFor(baseTile({ watchtower: true }), 256, 198, true)).toHaveLength(0);
    expect(await spritesFor(blockerTile(), 256, 88, true)).toHaveLength(0);
  });

  it('an arrowTower draws no atlas sprite even when the atlas is ready — it has no art yet', async () => {
    // getBuildingTexture is mocked to answer for ANY name here, so this would catch the
    // arrowTower branch accidentally falling into the blocker branch's placeBuildingSprite call.
    const tile = baseTile({ mine: true, structure: { kind: 'arrowTower', level: 1 } as WorldTileView['structure'] });
    expect(await spritesFor(tile, 256, 88)).toHaveLength(0);
  });

  it('falls back to the geometric markers when the atlas reports ready but the frame is missing', async () => {
    vi.resetModules();
    vi.doMock('../../src/render/atlas/buildingAtlasLoader', () => ({
      isBuildingAtlasReady: () => true,
      getBuildingTexture: () => null, // frame not in this atlas build
    }));
    const { drawTileL1: draw } = await import('../../src/scenes/worldmap/tileGraphics');
    const g = new PIXI.Graphics();
    const beginFills = spyBeginFill(g);
    draw(g, baseTile({ watchtower: true }), 0xffffff, 0x888888, false, TP, false, 'terrain_grass', null, 5, 5, 'w1');
    expect(g.children.filter((c) => c instanceof PIXI.Sprite)).toHaveLength(0);
    expect(beginFills.some((f) => f.color === 0xe8dcc0)).toBe(true); // geometric tower body
  });
});
