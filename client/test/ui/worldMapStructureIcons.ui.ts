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
