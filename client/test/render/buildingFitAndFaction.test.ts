/**
 * buildingFitAndFaction.test.ts — two BuildingView fixes from the 2026-10-08 CrazyGames review pass.
 *
 * 1. SIZE BEFORE DECODE. BuildingView used to size each sprite with `sp.width = SPRITE_SIZE` at
 *    acquire time and snapshot the resulting `scale.x` for the breathing pulse. A texture that has
 *    not decoded yet has a 1x1 `orig`, so the snapshot was 56 — and the pulse re-applied that 56
 *    every frame, overriding PIXI's own re-fit when the 252px tower art landed: the tower drew
 *    252 * 56 = 14112 px wide. The boot preload only warns on a slow/failed art step and continues,
 *    so on a slow connection a battle can start in exactly that state. Now the sprite stays hidden
 *    until the texture is valid, and the scale is taken from the decoded size.
 *
 * 2. FACTION CUES. Both sides' buildings are the same blue-black ink art, the barracks flag was a
 *    fixed grey and the tower's recoil ticks were always our blue — an enemy tower read as ours.
 *    Each building now stands on a faction ground patch, and its flag / recoil ticks are drawn in
 *    its owner's ink, mapped "local player = blue" exactly like UnitView's renderSide.
 *
 * Run with: npm test — the default suite's include covers every *.test.ts under test/.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface FakeTex { url: string; baseTexture: { valid: boolean }; orig: { width: number; height: number } }

// Shared with the mock factory below (vi.hoisted runs before the hoisted vi.mock).
const textures = vi.hoisted(() => new Map<string, FakeTex>());

vi.mock('pixi.js-legacy', () => {
  class FakeContainer {
    name = '';
    children: FakeContainer[] = [];
    parent: FakeContainer | null = null;
    visible = true;
    alpha = 1;
    angle = 0;
    x = 0; y = 0;
    scale = { x: 1, y: 1, set(v: number): void { this.x = v; this.y = v; } };
    addChild(...kids: FakeContainer[]): FakeContainer { for (const k of kids) { k.parent = this; this.children.push(k); } return kids[0]!; }
    removeFromParent(): void { this.parent = null; }
    getChildByName(n: string): FakeContainer | undefined { return this.children.find((c) => c.name === n); }
    destroy(): void { /* no-op */ }
  }
  /** Records the colour of every stroke style and fill, plus every ellipse, since the last clear(). */
  class FakeGraphics extends FakeContainer {
    lines: Array<{ width: number; color: number }> = [];
    fills: number[] = [];
    ellipses: Array<{ cx: number; cy: number; rx: number; ry: number }> = [];
    clear(): this { this.lines = []; this.fills = []; this.ellipses = []; return this; }
    lineStyle(width = 0, color = 0): this { this.lines.push({ width, color }); return this; }
    beginFill(color = 0): this { this.fills.push(color); return this; }
    endFill(): this { return this; }
    drawRect(): this { return this; }
    drawEllipse(cx: number, cy: number, rx: number, ry: number): this { this.ellipses.push({ cx, cy, rx, ry }); return this; }
    moveTo(): this { return this; }
    lineTo(): this { return this; }
    quadraticCurveTo(): this { return this; }
  }
  class FakeSprite extends FakeContainer {
    anchor = { set: (): void => {} };
    texture: FakeTex | null = null;
    // PIXI's width/height setters: scale = size / texture.orig — which is 1x1 before decode. Kept so
    // the pre-fix `sp.width = SPRITE_SIZE` path reproduces its real 56x scale here, not a no-op.
    get width(): number { return (this.texture?.orig.width ?? 0) * this.scale.x; }
    set width(v: number) { this.scale.x = v / (this.texture?.orig.width ?? 1); }
    get height(): number { return (this.texture?.orig.height ?? 0) * this.scale.y; }
    set height(v: number) { this.scale.y = v / (this.texture?.orig.height ?? 1); }
  }
  return {
    Container: FakeContainer,
    Graphics: FakeGraphics,
    Sprite: FakeSprite,
    // Like PIXI's cache: one texture object per URL, starting undecoded with the 1x1 placeholder orig.
    Texture: {
      from: (u: string): FakeTex => {
        let t = textures.get(u);
        if (!t) { t = { url: u, baseTexture: { valid: false }, orig: { width: 1, height: 1 } }; textures.set(u, t); }
        return t;
      },
    },
    Ticker: { shared: { add: (): void => {}, remove: (): void => {} } },
  };
});

import type * as PIXI from 'pixi.js-legacy';
import { BuildingView, buildingBaseScale, BUILDING_SPRITE_SIZE } from '../../src/render/BuildingView';
import { factionInkFor } from '../../src/render/factionCue';
import { factionInk } from '../../src/render/theme';
import { Building } from '@nw/engine/Building';
import { BuildingType, Side } from '@nw/engine/types';
import { BOTTOM_BUILDING_ROW, TOP_BUILDING_ROW } from '@nw/engine/config';
import type { Board } from '@nw/engine/Board';
import type { BoardView } from '../../src/render/BoardView';
import towerArtUrl from '../../src/assets/buildings/game_arrow_tower.png';
import barracksArtUrl from '../../src/assets/buildings/game_infantry_barracks.png';

// The real art's pixel sizes (IHDR of the shipped PNGs — towerArtContract.test.ts reads the same).
const TOWER_PX    = { width: 252, height: 256 };
const BARRACKS_PX = { width: 256, height: 171 };

/** Simulate the browser finishing the decode of one of the two building textures. */
function decode(url: string, px: { width: number; height: number }): void {
  const t = textures.get(url);
  if (t) { t.baseTexture.valid = true; t.orig = { ...px }; return; }   // landing after acquire
  textures.set(url, { url, baseTexture: { valid: true }, orig: { ...px } });   // decoded before the battle
}

function boardWith(...buildings: Building[]): Board {
  return { buildings: new Map(buildings.map((b) => [b.id, b])) } as unknown as Board;
}

const boardView = {
  gridToScreen: (col: number, row: number) => ({ x: col * 60, y: 500 - row * 60 }),
} as unknown as BoardView;

interface FakeGfx { lines: Array<{ width: number; color: number }>; fills: number[]; ellipses: Array<{ cx: number; cy: number; rx: number; ry: number }> }
interface FakeSpriteView { visible: boolean; scale: { x: number; y: number }; texture: FakeTex }

function partsOf(view: BuildingView, id: number): { sprite: FakeSpriteView; patch: FakeGfx; flag: FakeGfx } {
  const c = (view as unknown as { sprites: Map<number, { getChildByName(n: string): unknown }> }).sprites.get(id)!;
  return {
    sprite: c.getChildByName('sprite') as FakeSpriteView,
    patch:  c.getChildByName('patchGfx') as FakeGfx,
    flag:   c.getChildByName('flagGfx') as FakeGfx,
  };
}

/** On-screen width/height of a sprite: texture pixels times its current scale. */
function drawnSize(sp: FakeSpriteView): { w: number; h: number } {
  return { w: sp.texture.orig.width * sp.scale.x, h: sp.texture.orig.height * sp.scale.y };
}

beforeEach(() => {
  textures.clear();   // every test starts with nothing decoded
  // acquireSprite() seeds each building's idle phase with Math.random(); pinned to 0, the breathing
  // pulse is exactly 0 at time 0, so sizes on the first frames are exact (same reason as
  // buildingFireEffect.test.ts's pinPhase).
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BuildingView — sprite size waits for the texture to decode', () => {
  it('buildingBaseScale is null for an undecoded texture, SPRITE_SIZE / width once decoded', () => {
    const tex = { baseTexture: { valid: false }, orig: { width: 1, height: 1 } };
    expect(buildingBaseScale(tex as unknown as PIXI.Texture)).toBeNull();
    tex.baseTexture.valid = true;
    tex.orig = { ...TOWER_PX };
    expect(buildingBaseScale(tex as unknown as PIXI.Texture)).toBeCloseTo(56 / 252, 10);
  });

  it('hides a tower whose art has not decoded instead of fitting it to the 1x1 placeholder', () => {
    const view = new BuildingView(boardView, Side.Bottom);
    const board = boardWith(new Building(BuildingType.ArrowTower, Side.Bottom, 2, BOTTOM_BUILDING_ROW, undefined, 1));
    view.sync(board);
    view.update(0.37);
    view.sync(board);
    const { sprite, patch } = partsOf(view, 1);
    expect(sprite.visible).toBe(false);
    expect(sprite.scale.x).toBe(1);        // untouched — the old code wrote 56 here
    expect(patch.ellipses).toHaveLength(0); // the patch is laid with the art, not before it
  });

  it('draws the tower SPRITE_SIZE wide once the art lands mid-battle (was 252 * 56 = 14112 px)', () => {
    const view = new BuildingView(boardView, Side.Bottom);
    const board = boardWith(new Building(BuildingType.ArrowTower, Side.Bottom, 2, BOTTOM_BUILDING_ROW, undefined, 1));
    view.sync(board);                 // acquired while undecoded
    decode(towerArtUrl, TOWER_PX);
    view.sync(board);                 // next frame: fitted
    const { sprite } = partsOf(view, 1);
    expect(sprite.visible).toBe(true);
    expect(drawnSize(sprite).w).toBeCloseTo(BUILDING_SPRITE_SIZE, 6);   // 56
    expect(drawnSize(sprite).h).toBeCloseTo(256 * 56 / 252, 6);         // 56.9 — aspect kept

    // And the breathing pulse multiplies the decoded scale, not a stale one, frame after frame.
    for (const dt of [0.1, 0.37, 0.9]) {
      view.update(dt);
      view.sync(board);
      expect(Math.abs(drawnSize(sprite).w - 56)).toBeLessThanOrEqual(56 * 0.012 + 1e-9);   // BOB_SCALE_AMP
    }
  });

  it('keeps the barracks art at its 3:2 aspect: 56 x 37.4', () => {
    decode(barracksArtUrl, BARRACKS_PX);
    const view = new BuildingView(boardView, Side.Bottom);
    view.sync(boardWith(new Building(BuildingType.Barracks, Side.Bottom, 2, BOTTOM_BUILDING_ROW, undefined, 4)));
    const { sprite } = partsOf(view, 4);
    expect(sprite.visible).toBe(true);   // already decoded at acquire → shown on the first frame
    expect(drawnSize(sprite).w).toBeCloseTo(56, 6);
    expect(drawnSize(sprite).h).toBeCloseTo(171 * 56 / 256, 6);   // 37.4
  });

  it('lays the faction patch at the art\'s foot, sized off SPRITE_SIZE like a base\'s patch', () => {
    decode(towerArtUrl, TOWER_PX);
    const view = new BuildingView(boardView, Side.Bottom);
    view.sync(boardWith(new Building(BuildingType.ArrowTower, Side.Bottom, 2, BOTTOM_BUILDING_ROW, undefined, 1)));
    const { patch } = partsOf(view, 1);
    expect(patch.ellipses).toHaveLength(3);
    const outer = patch.ellipses[0]!;
    expect(outer.cx).toBe(0);
    expect(outer.cy).toBeCloseTo((256 * 56 / 252) / 2 * 0.9, 6);   // 25.6 — just above the art's bottom edge (28.4)
    expect(outer.rx).toBeCloseTo(56 * 0.34 * 1.3, 6);              // 24.8 — about the building's own width
    expect(outer.ry).toBeCloseTo(56 * 0.1 * 1.3, 6);               // 7.3
  });
});

describe('factionInkFor — local player is blue, whichever side they play', () => {
  it.each([
    [Side.Bottom, Side.Bottom, factionInk.friend],
    [Side.Top,    Side.Bottom, factionInk.enemy],
    [Side.Top,    Side.Top,    factionInk.friend],   // PvP joiner: their own Side.Top buildings are blue
    [Side.Bottom, Side.Top,    factionInk.enemy],
  ])('owner %s seen from local side %s', (owner, local, ink) => {
    expect(factionInkFor(owner, local)).toBe(ink);
  });
});

describe('BuildingView — buildings carry their owner\'s faction ink', () => {
  beforeEach(() => {
    decode(towerArtUrl, TOWER_PX);
    decode(barracksArtUrl, BARRACKS_PX);
  });

  const barracks = (side: Side, id: number): Building =>
    new Building(BuildingType.Barracks, side, 3, side === Side.Bottom ? BOTTOM_BUILDING_ROW : TOP_BUILDING_ROW, undefined, id);
  const tower = (side: Side, id: number): Building =>
    new Building(BuildingType.ArrowTower, side, 5, side === Side.Bottom ? BOTTOM_BUILDING_ROW : TOP_BUILDING_ROW, undefined, id);

  /** Colours of the flag cloth — every stroke style after the pole's. */
  const clothColors = (flag: FakeGfx): number[] => flag.lines.slice(1).map((l) => l.color);

  it.each([
    ['host / vs-AI (local = Bottom)', Side.Bottom, Side.Top],
    ['PvP joiner (local = Top)',      Side.Top,    Side.Bottom],
  ])('%s: own barracks blue, enemy barracks red — patch and flag', (_label, local, other) => {
    const view = new BuildingView(boardView, local);
    view.sync(boardWith(barracks(local, 1), barracks(other, 2)));

    const own = partsOf(view, 1), foe = partsOf(view, 2);
    expect(own.patch.fills).toEqual([factionInk.friend, factionInk.friend, factionInk.friend]);
    expect(foe.patch.fills).toEqual([factionInk.enemy, factionInk.enemy, factionInk.enemy]);
    expect(clothColors(own.flag)).toEqual([factionInk.friend]);
    expect(clothColors(foe.flag)).toEqual([factionInk.enemy]);
    // The pole stays pencil ink on both — only the cloth is the faction cue.
    expect(own.flag.lines[0]!.color).toBe(0x444444);
    expect(foe.flag.lines[0]!.color).toBe(0x444444);
  });

  it.each([
    ['host / vs-AI (local = Bottom)', Side.Bottom, Side.Top],
    ['PvP joiner (local = Top)',      Side.Top,    Side.Bottom],
  ])('%s: own tower recoils in blue, enemy tower in red', (_label, local, other) => {
    const view = new BuildingView(boardView, local);
    const ownT = tower(local, 7), foeT = tower(other, 8);
    const board = boardWith(ownT, foeT);
    view.sync(board);
    view.playFireEffect(7, ownT.col, ownT.row);
    view.playFireEffect(8, foeT.col, foeT.row);
    view.sync(board);

    expect(partsOf(view, 7).flag.lines.map((l) => l.color)).toEqual([factionInk.friend]);
    expect(partsOf(view, 8).flag.lines.map((l) => l.color)).toEqual([factionInk.enemy]);
    expect(partsOf(view, 7).patch.fills[0]).toBe(factionInk.friend);
    expect(partsOf(view, 8).patch.fills[0]).toBe(factionInk.enemy);
  });

  it('repaints the patch when a pooled container is reused by the other side', () => {
    const view = new BuildingView(boardView, Side.Bottom);
    view.sync(boardWith(barracks(Side.Bottom, 1)));
    const firstPatch = partsOf(view, 1).patch;
    expect(firstPatch.fills[0]).toBe(factionInk.friend);

    view.sync(boardWith());                       // released to the pool
    view.sync(boardWith(barracks(Side.Top, 2)));  // the same container comes back for the enemy
    const reused = partsOf(view, 2).patch;
    expect(reused).toBe(firstPatch);              // really the pooled one, or this tests nothing
    expect(reused.fills).toEqual([factionInk.enemy, factionInk.enemy, factionInk.enemy]);
  });
});
