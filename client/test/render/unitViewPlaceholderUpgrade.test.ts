/**
 * unitViewPlaceholderUpgrade.test.ts — guards the 2026-10-07 placeholder fix (art-direction §4.6,
 * design/product/unit-art-inventory.md §2).
 *
 * A unit that spawns before any of its art (frame sheet or .tao rig) has loaded is drawn as the
 * procedural draft stick figure. Before the fix it stayed that way for its whole life: UnitView only
 * picked the render path at spawn. Reproduced in real Chrome through a shared-replay deep link
 * (StatePlayerScene had no asset gate): the opening units played out as blue/red drafts to the end
 * of the replay while later spawns of the same type had real art.
 *
 * Covered here:
 *   1. a placeholder unit is swapped to its frame sheet on the first sync after the sheet loads,
 *      keeping its draw-order slot, and the old draft container goes back to the pool;
 *   2. a rig that lands first upgrades the placeholder too (a frame sheet is not required);
 *   3. units whose art never arrives stay placeholders — no churn, no throw;
 *   4. a unit spawned after the art is in never touches the placeholder path.
 *
 * Loaders are mocked with hand-resolved promises so the test controls exactly when art "arrives";
 * the two runtimes are mocked because the real ones need decoded textures. The gate wiring for the
 * replay scenes is pinned by test/appReplayAssetGate.test.ts.
 */
import '../harness/pixiHeadless';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { Board } from '@nw/engine/Board';
import { Unit } from '@nw/engine/Unit';
import { GameState } from '@nw/engine/GameState';
import { Side, UnitType } from '@nw/engine/types';

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const rigLoads = new Map<string, Deferred<unknown>>();
const sheetLoads = new Map<string, Deferred<unknown>>();
const pending = <T>(m: Map<string, Deferred<T>>, key: string): Deferred<T> => {
  let d = m.get(key);
  if (!d) { d = deferred<T>(); m.set(key, d); }
  return d;
};

function fakeRuntime(kind: 'rig' | 'frames') {
  const container = new PIXI.Container();
  container.name = `runtime:${kind}`;
  return {
    kind, container, currentDuration: 0,
    reset: vi.fn(), play: vi.fn(), syncState: vi.fn(), setAttackInterval: vi.fn(), update: vi.fn(),
    setOutlineFlash: vi.fn(), setGear: vi.fn(), destroy: vi.fn(),
    getShadowGround: () => null, getAttachmentOffset: () => null,
  };
}

vi.mock('../../src/render/stickman/StickmanRuntime', () => ({
  StickmanRuntime: class {
    static loadAsset(url: string): Promise<unknown> { return pending(rigLoads, url).promise; }
    constructor() { return fakeRuntime('rig'); }
  },
}));
vi.mock('../../src/render/frames/frameSheet', () => ({
  loadFrameSheet: (png: string) => pending(sheetLoads, png).promise,
}));
vi.mock('../../src/render/frames/FrameRuntime', () => ({
  FrameRuntime: class { constructor() { return fakeRuntime('frames'); } },
}));

import type { BoardView } from '../../src/render/BoardView';
import { UnitView } from '../../src/render/UnitView';
import { STICKMAN_ASSETS, FRAME_ASSETS } from '../../src/render/UnitView/assets';

/** Lets the loaders' `.then` callbacks (which fill UnitView's maps) run. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function isPlaceholder(c: PIXI.Container): boolean {
  return c.getChildByName('bodySprite') !== null && c.getChildByName('ringSprite') !== null;
}
function runtimeKind(c: PIXI.Container): string | null {
  const r = c.children.find((ch) => ch.name?.startsWith('runtime:'));
  return r ? r.name!.slice('runtime:'.length) : null;
}

function setup() {
  new GameState(1); // reset engine id counters
  const board = new Board();
  // UnitView only asks the board view for gridToScreen; the real one decodes the base art.
  const boardView = { gridToScreen: (c: number, r: number) => ({ x: c * 40, y: r * 40 }) } as unknown as BoardView;
  const view = new UnitView(boardView);
  const spriteOf = (u: Unit): PIXI.Container => (view as unknown as { sprites: Map<number, PIXI.Container> }).sprites.get(u.id)!;
  return { board, view, spriteOf };
}

describe('UnitView — a unit that spawned before its art loaded is upgraded when the art arrives', () => {
  beforeEach(() => { rigLoads.clear(); sheetLoads.clear(); });

  it('swaps the draft placeholder for the frame sheet on the next sync, in the same draw-order slot', async () => {
    const { board, view, spriteOf } = setup();
    const first = new Unit(UnitType.Max, Side.Top, 4, 10);
    const second = new Unit(UnitType.Infantry, Side.Bottom, 4, 2);
    board.addUnit(first);
    board.addUnit(second);

    view.sync(board, 1 / 60);
    const draft = spriteOf(first);
    expect(isPlaceholder(draft)).toBe(true);
    expect(isPlaceholder(spriteOf(second))).toBe(true);
    const slot = view.container.getChildIndex(draft);

    // Max's sheet lands; infantry's art is still in flight.
    pending(sheetLoads, FRAME_ASSETS[UnitType.Max]!.png).resolve({});
    await flush();
    view.sync(board, 1 / 60);

    const upgraded = spriteOf(first);
    expect(upgraded).not.toBe(draft);
    expect(isPlaceholder(upgraded)).toBe(false);
    expect(runtimeKind(upgraded)).toBe('frames');
    expect(view.container.getChildIndex(upgraded)).toBe(slot);
    expect(draft.parent).toBeNull(); // the draft went back to the pool, off the stage
    expect(isPlaceholder(spriteOf(second))).toBe(true); // no art yet for this one — untouched

    view.destroy();
  });

  it('a rig that loads before the sheet is enough to leave the placeholder', async () => {
    const { board, view, spriteOf } = setup();
    const u = new Unit(UnitType.Lena, Side.Top, 7, 10);
    board.addUnit(u);
    view.sync(board, 1 / 60);
    expect(isPlaceholder(spriteOf(u))).toBe(true);

    pending(rigLoads, STICKMAN_ASSETS[UnitType.Lena]!).resolve({ naturalHeight: 100 });
    await flush();
    view.sync(board, 1 / 60);
    expect(runtimeKind(spriteOf(u))).toBe('rig');

    view.destroy();
  });

  it('a unit whose art never arrives stays the same placeholder container across syncs', async () => {
    const { board, view, spriteOf } = setup();
    const u = new Unit(UnitType.Archer, Side.Bottom, 3, 2);
    board.addUnit(u);
    view.sync(board, 1 / 60);
    const draft = spriteOf(u);

    // Some OTHER type's art landing must not rebuild this one.
    pending(sheetLoads, FRAME_ASSETS[UnitType.Max]!.png).resolve({});
    await flush();
    view.sync(board, 1 / 60);
    view.sync(board, 1 / 60);
    expect(spriteOf(u)).toBe(draft);
    expect(isPlaceholder(draft)).toBe(true);

    view.destroy();
  });

  it('a unit spawned after its sheet loaded never goes through the placeholder', async () => {
    const { board, view, spriteOf } = setup();
    pending(sheetLoads, FRAME_ASSETS[UnitType.Max]!.png).resolve({});
    await flush();
    const u = new Unit(UnitType.Max, Side.Top, 4, 10);
    board.addUnit(u);
    view.sync(board, 1 / 60);
    expect(runtimeKind(spriteOf(u))).toBe('frames');

    view.destroy();
  });
});
