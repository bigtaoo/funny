/**
 * buildingFireEffect.test.ts — the arrow tower's fire recoil (BuildingView.playFireEffect),
 * added 2026-08-19 when the tower got its own art and the user asked for barracks-style animation.
 *
 * The part worth pinning is the guard, not the motion: `projectile_fired.attackerId` is a BUILDING
 * id when a tower shoots and a UNIT id when an archer shoots, and those come from two separate
 * counters (`allocBuildingId` / `allocUnitId`) — so the same small integer means both. Matching on
 * the id alone would make an archer's arrow kick an unrelated tower, which is the kind of bug that
 * only shows up in a busy lane and looks like "the tower twitches at random". A building's shot
 * always originates at its own cell, so the origin cell is the discriminator.
 *
 * Run with: npm test — the default suite's include covers every *.test.ts under test/.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Minimal PIXI stub — enough for BuildingView to build/pool its containers ──
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
  class FakeGraphics extends FakeContainer {
    strokes = 0;
    clear(): this { this.strokes = 0; return this; }
    lineStyle(): this { return this; }
    beginFill(): this { return this; }
    endFill(): this { return this; }
    drawRect(): this { return this; }
    moveTo(): this { this.strokes++; return this; }
    lineTo(): this { return this; }
    quadraticCurveTo(): this { return this; }
  }
  class FakeSprite extends FakeContainer {
    anchor = { set: (): void => {} };
    texture: unknown = null;
    width = 0; height = 0;
  }
  return {
    Container: FakeContainer,
    Graphics: FakeGraphics,
    Sprite: FakeSprite,
    Texture: { from: (u: string): unknown => ({ url: u }) },
    Ticker: { shared: { add: (): void => {}, remove: (): void => {} } },
  };
});

import { BuildingView } from '../../src/render/BuildingView';
import { Building } from '@nw/engine/Building';
import { BuildingType, Side } from '@nw/engine/types';
import type { Board } from '@nw/engine/Board';
import type { BoardView } from '../../src/render/BoardView';
import towerArtUrl from '../../src/assets/buildings/game_arrow_tower.png';
import barracksArtUrl from '../../src/assets/buildings/game_infantry_barracks.png';

const TOWER_ID = 7;
const COL = 3, ROW = 0;

/** Board stub: BuildingView only ever reads `.buildings`. */
function boardWith(...buildings: Building[]): Board {
  return { buildings: new Map(buildings.map((b) => [b.id, b])) } as unknown as Board;
}

/** BoardView stub: a plain grid, so "toward the enemy row" is straight up in screen space. */
const boardView = {
  gridToScreen: (col: number, row: number) => ({ x: col * 60, y: 500 - row * 60 }),
} as unknown as BoardView;

/** Landscape-shaped stub: rows run along x, so a shot kicks the sprite horizontally. */
const rotatedBoardView = {
  gridToScreen: (col: number, row: number) => ({ x: 500 - row * 60, y: col * 60 }),
} as unknown as BoardView;

function towerAt(col = COL, row = ROW, id = TOWER_ID): Building {
  return new Building(BuildingType.ArrowTower, Side.Bottom, col, row, undefined, id);
}

function spriteOf(view: BuildingView, id: number): { x: number; y: number; texture: { url: string } } {
  const container = (view as unknown as {
    sprites: Map<number, { getChildByName(n: string): { x: number; y: number; texture: { url: string } } }>;
  }).sprites.get(id)!;
  return container.getChildByName('sprite');
}

/** Pin the idle phase so the breathing scale pulse is deterministic — see the note in beforeEach. */
function pinPhase(view: BuildingView, id: number): void {
  (view as unknown as { phases: Map<number, number> }).phases.set(id, 0);
}

describe('BuildingView.playFireEffect', () => {
  let view: BuildingView;
  let board: Board;

  beforeEach(() => {
    view = new BuildingView(boardView);
    board = boardWith(towerAt());
    view.sync(board);
    // acquireSprite() seeds each building's idle phase with Math.random(), so the breathing pulse
    // is a coin flip and any assertion on the sprite's absolute scale is flaky by construction —
    // this very test passed alone and failed in the full run before the phase was pinned. Pinned
    // to 0: at time 0 the pulse contributes exactly 0. The idle animation is a scale pulse only
    // (see BOB_SCALE_AMP in BuildingView.ts) and never touches sp.x/sp.y, so the recoil below is
    // the only thing that moves the sprite's position.
    pinPhase(view, TOWER_ID);
    view.sync(board);
  });

  it('kicks the tower back when the shot comes from its own cell', () => {
    const before = spriteOf(view, TOWER_ID).y;
    view.playFireEffect(TOWER_ID, COL, ROW);
    view.sync(board);   // no update() in between: time — and therefore the bob — is unchanged
    // Enemy row is up-screen in the stub grid, so the recoil pushes the sprite down (+y), not sideways.
    expect(spriteOf(view, TOWER_ID).y - before).toBeCloseTo(2.8, 5);   // FIRE_KICK_PX at full strength
    expect(spriteOf(view, TOWER_ID).x).toBeCloseTo(0, 10);             // toBe(0) trips on -0 (Object.is)
  });

  it('ignores a shot whose origin cell is not the building\'s — an archer unit sharing the id', () => {
    // Same numeric id, fired from a different cell: a unit's arrow, not this tower's.
    view.playFireEffect(TOWER_ID, COL + 4, ROW + 2);
    view.sync(board);
    const sp = spriteOf(view, TOWER_ID);
    expect(sp.x).toBe(0);
    expect(sp.y).toBe(0); // idle animation is a scale pulse now — never touches position
  });

  it('ignores an id it has no sprite for', () => {
    expect(() => view.playFireEffect(TOWER_ID + 99, COL, ROW)).not.toThrow();
  });

  it('settles back to y=0 once the recoil elapses — idle no longer moves the sprite', () => {
    view.playFireEffect(TOWER_ID, COL, ROW);
    view.sync(board);
    expect(Math.abs(spriteOf(view, TOWER_ID).y)).toBeGreaterThan(0);   // the kick moves it

    view.update(0.5);            // well past FIRE_SECONDS
    view.sync(board);
    // Nothing is left to move it back to: idle is a scale pulse, not a position offset.
    expect(spriteOf(view, TOWER_ID).y).toBe(0);
    expect(spriteOf(view, TOWER_ID).x).toBeCloseTo(0, 10);
  });

  it('draws the recoil ticks only while a shot is in flight', () => {
    const gfx = (view as unknown as { sprites: Map<number, { getChildByName(n: string): { strokes: number } }> })
      .sprites.get(TOWER_ID)!.getChildByName('flagGfx');
    expect(gfx.strokes).toBe(0);

    view.playFireEffect(TOWER_ID, COL, ROW);
    view.sync(board);
    expect(gfx.strokes).toBe(2);   // two strokes trailing off the back

    view.update(0.5);
    view.sync(board);
    expect(gfx.strokes).toBe(0);
  });

  it('leaves every other tower alone when one of them shoots', () => {
    const other = towerAt(COL + 2, ROW, TOWER_ID + 1);
    board = boardWith(towerAt(), other);
    view.sync(board);
    pinPhase(view, TOWER_ID);
    pinPhase(view, TOWER_ID + 1);
    view.sync(board);
    const otherBefore = spriteOf(view, TOWER_ID + 1).y;

    view.playFireEffect(TOWER_ID, COL, ROW);
    view.sync(board);

    expect(spriteOf(view, TOWER_ID).y - 0).toBeCloseTo(2.8, 5);          // the shooter kicks
    expect(spriteOf(view, TOWER_ID + 1).y).toBe(otherBefore);            // its neighbour does not
  });

  it('does not carry a kick into a barracks that reuses the pooled container', () => {
    // Two things have to line up for this to test anything. It needs the LANDSCAPE layout, because
    // only there does the kick have an x component at all (portrait kicks purely along y, which the
    // tower's no-fire branch zeroes every frame anyway). And the container has to be reused by a
    // BARRACKS: the tower branch rewrites sprite.x every frame and would mask the bug, while the
    // barracks branch returns before touching it. Verified by deleting the reset line — a tower
    // here still passed.
    const lView = new BuildingView(rotatedBoardView);
    const lBoard = boardWith(towerAt());
    lView.sync(lBoard);
    pinPhase(lView, TOWER_ID);
    lView.playFireEffect(TOWER_ID, COL, ROW);
    lView.sync(lBoard);
    expect(Math.abs(spriteOf(lView, TOWER_ID).x)).toBeGreaterThan(1);

    lView.sync(boardWith());                                 // tower gone → container released
    const reused = new Building(BuildingType.Barracks, Side.Bottom, COL + 1, ROW, undefined, TOWER_ID + 5);
    lView.sync(boardWith(reused));
    expect(spriteOf(lView, TOWER_ID + 5).x).toBeCloseTo(0, 10);
  });

  it('kicks along whichever screen axis the current orientation maps the enemy row to', () => {
    // Landscape lays the board's rows out along x instead of y (verified in a real capture: the
    // recoil landed on x). shotDirection() recomputes per shot from gridToScreen, so the same cell
    // must produce a horizontal kick under a rotated layout.
    const rotatedView = new BuildingView(rotatedBoardView);
    const rotatedBoard = boardWith(towerAt());
    rotatedView.sync(rotatedBoard);
    pinPhase(rotatedView, TOWER_ID);
    rotatedView.sync(rotatedBoard);

    rotatedView.playFireEffect(TOWER_ID, COL, ROW);
    rotatedView.sync(rotatedBoard);
    const sp = spriteOf(rotatedView, TOWER_ID);
    expect(sp.x).toBeCloseTo(2.8, 5);      // horizontal now
    expect(sp.y).toBeCloseTo(0, 10);       // idle never touches position, so nothing vertical at all
  });

  it('breathes via a scale pulse and never drifts sp.x/sp.y while idle (2026-08-25 fix)', () => {
    // Was a ±1.5px sp.y offset that desynced the sprite from its own HP bar/flag (drawn at fixed
    // container-local coordinates) and beat against the tower's independent-frequency sway —
    // reported as "看着眼花，容易分散注意力". Replaced with a scale pulse, which can't desync from
    // siblings drawn in the same local space.
    const id = TOWER_ID + 10;
    const bBoard = boardWith(new Building(BuildingType.Barracks, Side.Bottom, COL, ROW, undefined, id));
    const bView = new BuildingView(boardView);
    bView.sync(bBoard);
    pinPhase(bView, id);
    bView.sync(bBoard);
    const sp = spriteOf(bView, id) as unknown as { x: number; y: number; scale: { x: number } };
    expect(sp.x).toBe(0);
    expect(sp.y).toBe(0);
    expect(sp.scale.x).toBe(1);   // sin(0) === 0 at the pinned phase

    bView.update(0.37);
    bView.sync(bBoard);
    expect(sp.x).toBe(0);
    expect(sp.y).toBe(0);                                          // idle never moves the sprite
    expect(sp.scale.x).not.toBe(1);                                // but it does pulse the scale
    expect(Math.abs(sp.scale.x - 1)).toBeLessThanOrEqual(0.012);   // BOB_SCALE_AMP bound
  });

  it('pulses the tower body the same way, independent of its own sway angle', () => {
    // The scale pulse is written unconditionally before the barracks/tower branch, so a tower
    // must breathe too — not just get folded into "tower has its own animation, must be fine".
    pinPhase(view, TOWER_ID);
    view.update(0.37);
    view.sync(board);
    const sp = spriteOf(view, TOWER_ID) as unknown as { scale: { x: number } };
    expect(sp.scale.x).not.toBe(1);
    expect(Math.abs(sp.scale.x - 1)).toBeLessThanOrEqual(0.012);   // BOB_SCALE_AMP bound
  });

  it('drops a released building\'s baseScale entry — no unbounded growth across a battle', () => {
    const id = TOWER_ID + 11;
    board = boardWith(towerAt(), towerAt(COL + 1, ROW, id));
    view.sync(board);
    const baseScales = (view as unknown as { baseScales: Map<number, number> }).baseScales;
    expect(baseScales.has(id)).toBe(true);

    board = boardWith(towerAt());   // the second tower is destroyed/leaves the board
    view.sync(board);
    expect(baseScales.has(id)).toBe(false);
  });

  it('destroy() clears baseScales along with the other per-building maps', () => {
    const baseScales = (view as unknown as { baseScales: Map<number, number> }).baseScales;
    expect(baseScales.size).toBeGreaterThan(0);   // the beforeEach tower is still live
    view.destroy();
    expect(baseScales.size).toBe(0);
  });

  it('gives each building type its own art — the two used to share one file', () => {
    // The tower spent a long release borrowing game_archer_barracks.png, the barracks' neighbour in
    // spirit and in filename. Swapping the asset touches four wiring sites; this pins the two that
    // decide what the board actually draws.
    const both = boardWith(towerAt(), new Building(BuildingType.Barracks, Side.Bottom, COL + 1, ROW, undefined, TOWER_ID + 3));
    view.sync(both);
    expect(spriteOf(view, TOWER_ID).texture.url).toBe(towerArtUrl);
    expect(spriteOf(view, TOWER_ID + 3).texture.url).toBe(barracksArtUrl);
    expect(towerArtUrl).not.toBe(barracksArtUrl);
  });
});
