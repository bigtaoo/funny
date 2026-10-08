/**
 * tutorialDirector.test.ts — the 2026-10 first-minute tutorial state machine (ONBOARDING_DESIGN §11).
 *
 * Drives TutorialDirector with a hand-built GameState (no engine): the beats freeze only once their
 * setupTick is reached ("move, then freeze"), only the guided card *by id* near its target is let
 * through (aim-assisted onto the target), a wrong drop is counted and starts the ghost demo, the
 * meteor anchor is the 2×2 covering the most enemies, and the meteor ends in WIN → graduation card →
 * finish() on the card's button. No "Next" button exists anywhere.
 *
 * Run with: npm test — the default suite's include covers every *.test.ts under test/.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Minimal PIXI stub — only what TutorialDirector/panels/pixiText/sketchUi/hudButton touch ──
vi.mock('pixi.js-legacy', () => {
  class Point { x = 0; y = 0; set(x: number, y?: number): void { this.x = x; this.y = y ?? x; } }
  class FakeContainer {
    children: FakeContainer[] = [];
    visible = true; alpha = 1; width = 10; height = 10;
    position = new Point(); scale = new Point(); pivot = new Point();
    get x(): number { return this.position.x; } set x(v: number) { this.position.x = v; }
    get y(): number { return this.position.y; } set y(v: number) { this.position.y = v; }
    constructor() { this.scale.set(1); }
    addChild(...c: FakeContainer[]): FakeContainer { this.children.push(...c); return c[0]!; }
    removeChild(c: FakeContainer): void { this.children = this.children.filter((x) => x !== c); }
    removeChildren(): FakeContainer[] { const r = this.children; this.children = []; return r; }
    destroy(): void { /* no-op */ }
  }
  class FakeGraphics extends FakeContainer {
    beginFill(): this { return this; }
    endFill(): this { return this; }
    lineStyle(): this { return this; }
    drawRect(): this { return this; }
    drawRoundedRect(): this { return this; }
    drawCircle(): this { return this; }
    clear(): this { return this; }
  }
  class FakeText extends FakeContainer {
    text: string;
    style: Record<string, unknown>;
    anchor = new Point();
    constructor(text = '', style: Record<string, unknown> = {}) { super(); this.text = text; this.style = { ...style }; }
  }
  return {
    Container: FakeContainer,
    Graphics: FakeGraphics,
    Text: FakeText,
    settings: { ADAPTER: {} },
    RENDERER_TYPE: { CANVAS: 2, WEBGL: 1 },
  };
});

import * as PIXI from 'pixi.js-legacy';
import { TutorialDirector, type TutorialConfig, type TutorialHost } from '../../src/render/TutorialDirector';
import { bestMeteorAnchor } from '../../src/render/TutorialDirector/geometry';
import { BEATS } from '../../src/render/TutorialDirector/beats';
import { Side, type GameState } from '../../src/game';
import type { ILayout, Rect } from '../../src/layout/ILayout';

function fakeLayout(): ILayout {
  const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
  return {
    orientation: 'landscape',
    designWidth: 1920,
    designHeight: 1080,
    cellSize: 70,
    boardRect: rect(330, 40, 1260, 840),
    handRect: rect(330, 950, 1260, 130),
    cardWidth: 120,
    cardHeight: 160,
    gridToScreen: (col: number, row: number) => ({ x: 330 + row * 70, y: 40 + col * 70 }),
    playerBaseRect: () => rect(250, 400, 80, 80),
    enemyBaseRect: () => rect(1590, 400, 80, 80),
  } as unknown as ILayout;
}

interface FakeUnit { side: Side; col: number; row: number; isDead: boolean }

function fakeState(handIds: string[]): GameState & { units: FakeUnit[] } {
  const units: FakeUnit[] = [];
  return {
    units,
    elapsedTicks: 0,
    bottomPlayer: { baseHp_fp: 1 << 20, hand: { slots: handIds.map((id) => ({ card: { id } })) } },
    board: { units: { values: () => units.values() } },
  } as unknown as GameState & { units: FakeUnit[] };
}

describe('TutorialDirector', () => {
  let host: TutorialHost & { [k: string]: ReturnType<typeof vi.fn> | unknown };
  let config: TutorialConfig & { onStep: ReturnType<typeof vi.fn>; onBeatDone: ReturnType<typeof vi.fn> };
  let director: TutorialDirector;
  let state: ReturnType<typeof fakeState>;

  const frame = (dt = 1 / 60): void => director.onTick(state, dt);
  const runTo = (tick: number): void => { (state as { elapsedTicks: number }).elapsedTicks = tick; frame(); };

  beforeEach(() => {
    config = { ctaLabel: 'Next battle »', teaser: 'First win: +1,000 coins', onStep: vi.fn(), onBeatDone: vi.fn() };
    host = {
      container: new PIXI.Container(),
      layout: fakeLayout(),
      config,
      highlightUnitLane: vi.fn(),
      highlightBuildingLane: vi.fn(),
      clearLaneHighlights: vi.fn(),
      handSlotCenter: () => ({ x: 400, y: 1000 }),
      buildCardGhost: () => new PIXI.Container(),
      forceVictory: vi.fn(),
      finish: vi.fn(),
      onSkip: vi.fn(),
    } as unknown as typeof host;
    state = fakeState(['infantry_1', 'tower_1', 'meteor_1', 'barracks_1']);
    director = new TutorialDirector(host);
  });

  it('runs the engine until the beat setupTick, then freezes on the unit beat', () => {
    runTo(BEATS[0]!.setupTick - 1);
    expect(director.engineFrozen).toBe(false);
    expect(config.onStep).not.toHaveBeenCalled();
    runTo(BEATS[0]!.setupTick);
    expect(director.engineFrozen).toBe(true);
    expect(config.onStep).toHaveBeenCalledWith('beat_unit');
    expect(host.highlightUnitLane).toHaveBeenCalledWith(BEATS[0]!.col);
  });

  it('rejects every play outside a prompt', () => {
    expect(director.allowCardPlay('infantry_1', BEATS[0]!.col, 1)).toBeNull();
  });

  it('accepts only the guided card id near its lane, snapped onto the lane; wrong drops are counted', () => {
    runTo(BEATS[0]!.setupTick);
    expect(director.allowCardPlay('barracks_1', BEATS[0]!.col, 1)).toBeNull(); // wrong card
    expect(director.allowCardPlay('infantry_1', BEATS[0]!.col + 3, 1)).toBeNull(); // wrong lane
    expect(director.allowCardPlay('infantry_1', BEATS[0]!.col - 1, 1)).toEqual({ col: BEATS[0]!.col, row: 1 });
    frame(); // release
    expect(director.engineFrozen).toBe(false);
    expect(config.onBeatDone).toHaveBeenCalledWith(expect.objectContaining({ beat: 'unit', wrong_drops: 2, ghost_shown: true }));
  });

  it('a building of the wrong id (barracks) does not pass the tower beat', () => {
    runTo(BEATS[0]!.setupTick);
    director.allowCardPlay('infantry_1', BEATS[0]!.col, 1); frame();
    runTo(BEATS[1]!.setupTick);
    expect(config.onStep).toHaveBeenLastCalledWith('beat_building');
    expect(director.allowCardPlay('barracks_1', BEATS[1]!.col, 0)).toBeNull();
    expect(director.allowCardPlay('tower_1', BEATS[1]!.col, 0)).toEqual({ col: BEATS[1]!.col, row: 0 });
  });

  it('starts the ghost demo after the idle threshold, and a held card stops it', () => {
    runTo(BEATS[0]!.setupTick);
    const ghost = (director as unknown as { ghostOn: boolean });
    frame(1.0);
    expect(ghost.ghostOn).toBe(false);
    frame(1.1);
    expect(ghost.ghostOn).toBe(true);
    director.setHoldingCard(true);
    expect(ghost.ghostOn).toBe(false);
  });

  it('meteor beat: aim-assists onto the 2×2 covering the cluster, then WIN → graduation card → finish', () => {
    runTo(BEATS[0]!.setupTick); director.allowCardPlay('infantry_1', BEATS[0]!.col, 1); frame();
    runTo(BEATS[1]!.setupTick); director.allowCardPlay('tower_1', BEATS[1]!.col, 0); frame();
    state.units.push(
      { side: Side.Top, col: 2, row: 9, isDead: false }, { side: Side.Top, col: 2, row: 10, isDead: false },
      { side: Side.Top, col: 3, row: 9, isDead: false }, { side: Side.Top, col: 3, row: 10, isDead: false },
    );
    runTo(BEATS[2]!.setupTick);
    expect(config.onStep).toHaveBeenLastCalledWith('beat_spell');
    expect(director.allowCardPlay('meteor_1', 3, 11)).toEqual({ col: 2, row: 9 }); // dropped a cell off, snapped
    frame(); // release → finale
    for (const u of state.units) u.isDead = true; // the meteor landed
    frame(); frame(0.6);
    expect(host.forceVictory).toHaveBeenCalledTimes(1);
    expect(config.onStep).toHaveBeenLastCalledWith('graduate');
    expect(director.isFinished).toBe(true);

    // Graduation card pops in, then its button (and only its button) leaves.
    frame(0.6); frame(0.3);
    const cta = (director as unknown as { ctaRect: Rect }).ctaRect;
    expect(director.handleDown(0, 0)).toBe(true);
    expect(host.finish).not.toHaveBeenCalled();
    director.handleDown(cta.x + 1, cta.y + 1);
    expect(host.finish).toHaveBeenCalledTimes(1);
  });
});

describe('bestMeteorAnchor', () => {
  it('picks the 2×2 that covers the most enemies and ignores the player\'s own units', () => {
    const s = fakeState([]);
    s.units.push(
      { side: Side.Top, col: 7, row: 3, isDead: false },
      { side: Side.Top, col: 2, row: 9, isDead: false }, { side: Side.Top, col: 3, row: 10, isDead: false },
      { side: Side.Top, col: 3, row: 9, isDead: false },
      { side: Side.Bottom, col: 7, row: 4, isDead: false }, { side: Side.Bottom, col: 7, row: 3, isDead: false },
      { side: Side.Top, col: 2, row: 10, isDead: true },
    );
    expect(bestMeteorAnchor(s)).toEqual({ col: 2, row: 9 });
  });

  it('returns null with no enemy on the board', () => {
    expect(bestMeteorAnchor(fakeState([]))).toBeNull();
  });
});
