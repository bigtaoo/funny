/**
 * unitViewBoardSize.test.ts — UnitView sizes every unit from the board's cell size through ONE value,
 * `boardUnitHeight(type, cellSize)` (render/unitSize.ts, ADR-105 amendment 2026-10-08).
 *
 * On a small landscape board (722×406 → cell 42) units shrink by 42/54 so a Medium figure stays one
 * cell tall instead of 1.29. Every consumer anchored on the unit's height has to follow the same
 * number or the pieces drift apart (an HP bar floating above a shrunken head, a draft placeholder
 * bigger than the art that replaces it). Pinned here:
 *   1. the frame-sheet and rig runtimes get `targetHeight = boardUnitHeight`, also on pool reuse;
 *   2. the stickman HP bar sits at `-round(0.6 × boardUnitHeight)`;
 *   3. the draft placeholder is drawn at `boardUnitHeight`;
 *   4. a board view without a cell size (old stubs) keeps the full tier height.
 *
 * Runtimes and the draft painter are mocked to record what they were asked for; loaders resolve
 * on demand like unitViewPlaceholderUpgrade.test.ts.
 */
import '../harness/pixiHeadless';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { Board } from '@nw/engine/Board';
import { Unit } from '@nw/engine/Unit';
import { GameState } from '@nw/engine/GameState';
import { Side, UnitType } from '@nw/engine/types';

const runtimeOptions: Array<{ kind: string; targetHeight?: number }> = [];
const resetOptions: Array<{ targetHeight?: number }> = [];
const draftHeights: number[] = [];
const sheetResolvers = new Map<string, () => void>();

function fakeRuntime(kind: 'rig' | 'frames', options: { targetHeight?: number }) {
  runtimeOptions.push({ kind, targetHeight: options.targetHeight });
  return {
    kind, container: new PIXI.Container(), currentDuration: 0,
    reset: (o: { targetHeight?: number }) => { resetOptions.push(o); },
    play: vi.fn(), syncState: vi.fn(), setAttackInterval: vi.fn(), update: vi.fn(),
    setOutlineFlash: vi.fn(), setGear: vi.fn(), destroy: vi.fn(),
    getShadowGround: () => null, getAttachmentOffset: () => null,
  };
}

vi.mock('../../src/render/stickman/StickmanRuntime', () => ({
  StickmanRuntime: class {
    static loadAsset(): Promise<unknown> { return new Promise(() => {}); }
    constructor(_a: unknown, o: { targetHeight?: number }) { return fakeRuntime('rig', o); }
  },
}));
vi.mock('../../src/render/frames/frameSheet', () => ({
  loadFrameSheet: (png: string) => new Promise((resolve) => { sheetResolvers.set(png, () => resolve({})); }),
}));
vi.mock('../../src/render/frames/FrameRuntime', () => ({
  FrameRuntime: class { constructor(_s: unknown, o: { targetHeight?: number }) { return fakeRuntime('frames', o); } },
}));
vi.mock('../../src/render/stickmanDraft', async (orig) => ({
  ...(await orig<typeof import('../../src/render/stickmanDraft')>()),
  draftTexture: () => null,
  drawStickmanDraft: (_g: unknown, _side: unknown, targetH: number) => { draftHeights.push(targetH); },
}));

import type { BoardView } from '../../src/render/BoardView';
import { UnitView } from '../../src/render/UnitView';
import { FRAME_ASSETS } from '../../src/render/UnitView/assets';
import { boardUnitHeight, targetScreenHeight } from '../../src/render/unitSize';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function setup(cellSize: number | undefined) {
  new GameState(1); // reset engine id counters
  const board = new Board();
  const boardView = {
    gridToScreen: (c: number, r: number) => ({ x: c * 40, y: r * 40 }), cellSize,
  } as unknown as BoardView;
  const view = new UnitView(boardView);
  const spriteOf = (u: Unit): PIXI.Container => (view as unknown as { sprites: Map<number, PIXI.Container> }).sprites.get(u.id)!;
  return { board, view, spriteOf };
}

describe('UnitView — every unit-height consumer takes boardUnitHeight', () => {
  beforeEach(() => {
    runtimeOptions.length = 0; resetOptions.length = 0; draftHeights.length = 0; sheetResolvers.clear();
  });

  it('on a 42 px cell (722×406) the draft, the runtime and the HP bar all use the shrunken height', async () => {
    const { board, view, spriteOf } = setup(42);
    const shield = new Unit(UnitType.ShieldBearer, Side.Bottom, 4, 2);
    board.addUnit(shield);
    view.sync(board, 1 / 60);
    const h = boardUnitHeight(UnitType.ShieldBearer, 42);
    expect(h).toBeLessThan(targetScreenHeight(UnitType.ShieldBearer));
    expect(draftHeights).toEqual([h]);

    sheetResolvers.get(FRAME_ASSETS[UnitType.ShieldBearer]!.png)!();
    await flush();
    view.sync(board, 1 / 60);
    expect(runtimeOptions).toEqual([{ kind: 'frames', targetHeight: h }]);
    const hpFill = spriteOf(shield).getChildByName('hpFill') as PIXI.Sprite;
    const hpBg = spriteOf(shield).getChildByName('hpBg') as PIXI.Sprite;
    expect(hpBg.y).toBe(-Math.round(h * 0.6));
    expect(hpFill.y).toBe(-Math.round(h * 0.6));

    // Pool reuse: the next spawn of the same type gets its pair back, reset to the same height.
    board.removeUnit(shield);
    view.sync(board, 1 / 60);
    const again = new Unit(UnitType.ShieldBearer, Side.Bottom, 5, 2);
    board.addUnit(again);
    view.sync(board, 1 / 60);
    expect(runtimeOptions).toHaveLength(1);
    expect(resetOptions.map((o) => o.targetHeight)).toEqual([h]);
    view.destroy();
  });

  it('without a cell size (stub board view) units keep their full tier height', () => {
    const { board, view } = setup(undefined);
    board.addUnit(new Unit(UnitType.Ironclad, Side.Top, 4, 10));
    view.sync(board, 1 / 60);
    expect(draftHeights).toEqual([targetScreenHeight(UnitType.Ironclad)]);
    view.destroy();
  });
});
