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
    scale = { _v: 1, set(v: number): void { this._v = v; } };
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

function towerAt(col = COL, row = ROW): Building {
  return new Building(BuildingType.ArrowTower, Side.Bottom, col, row, undefined, TOWER_ID);
}

function spriteOf(view: BuildingView, id: number): { x: number; y: number } {
  const container = (view as unknown as { sprites: Map<number, { getChildByName(n: string): { x: number; y: number } }> })
    .sprites.get(id)!;
  return container.getChildByName('sprite');
}

describe('BuildingView.playFireEffect', () => {
  let view: BuildingView;
  let board: Board;

  beforeEach(() => {
    view = new BuildingView(boardView);
    board = boardWith(towerAt());
    view.sync(board);
    // acquireSprite() seeds each building's idle phase with Math.random(), so the bob term is a
    // coin flip and any assertion on the sprite's absolute offset is flaky by construction — this
    // very test passed alone and failed in the full run before the phase was pinned. Pinned to 0:
    // at time 0 the bob contributes exactly 0, leaving the recoil as the only thing moving.
    (view as unknown as { phases: Map<number, number> }).phases.set(TOWER_ID, 0);
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
    expect(Math.abs(sp.y)).toBeLessThanOrEqual(1.5); // idle bob only (BOB_AMP)
  });

  it('ignores an id it has no sprite for', () => {
    expect(() => view.playFireEffect(TOWER_ID + 99, COL, ROW)).not.toThrow();
  });

  it('settles back to the idle bob once the recoil elapses', () => {
    const BOB_AMP = 1.5;
    view.playFireEffect(TOWER_ID, COL, ROW);
    view.sync(board);
    expect(Math.abs(spriteOf(view, TOWER_ID).y)).toBeGreaterThan(BOB_AMP);   // kick dominates

    view.update(0.5);            // well past FIRE_SECONDS
    view.sync(board);
    // Only the bob is left, and with the phase pinned its amplitude is a hard bound.
    expect(Math.abs(spriteOf(view, TOWER_ID).y)).toBeLessThanOrEqual(BOB_AMP);
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
});
