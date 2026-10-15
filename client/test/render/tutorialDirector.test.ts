/**
 * tutorialDirector.test.ts — the 2026-10 first-minute tutorial state machine (ONBOARDING_DESIGN §11).
 *
 * Drives TutorialDirector with a hand-built GameState (no engine): the beats freeze only once their
 * setupTick is reached ("move, then freeze"), only the guided card *by id* near its target is let
 * through (aim-assisted onto the target), a wrong drop is counted and starts the ghost demo, the
 * meteor anchor is the 2×2 covering the most enemies, and the meteor ends in WIN → graduation card →
 * finish() on the card's button. No "Next" button exists anywhere. In the free fight after the meteor
 * an idle player is frozen on a "play a card" prompt until they play (§17.7).
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
import { BEATS, FREE_IDLE_PROMPT_SEC, FREE_SETTLE_TICKS, TUTORIAL_NEW_CARD } from '../../src/render/TutorialDirector/beats';
import { CardType, GamePhase, Side, type GameState } from '../../src/game';
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

  /** Plays the three guided beats; leaves the director in the free phase. */
  const playBeats = (): void => {
    runTo(BEATS[0]!.setupTick); director.allowCardPlay('infantry_1', BEATS[0]!.col, 1); frame();
    runTo(BEATS[1]!.setupTick); director.allowCardPlay('tower_1', BEATS[1]!.col, 0); frame();
    state.units.push(
      { side: Side.Top, col: 2, row: 9, isDead: false }, { side: Side.Top, col: 2, row: 10, isDead: false },
      { side: Side.Top, col: 3, row: 9, isDead: false }, { side: Side.Top, col: 3, row: 10, isDead: false },
    );
    runTo(BEATS[2]!.setupTick);
    expect(config.onStep).toHaveBeenLastCalledWith('beat_spell');
    expect(director.allowCardPlay('meteor_1', 3, 11)).toEqual({ col: 2, row: 9 }); // dropped a cell off, snapped
    frame(); // release → free
  };

  it('after the meteor the fight runs free: any card anywhere, no win until the engine settles', () => {
    playBeats();
    expect(config.onStep).toHaveBeenLastCalledWith('graduate');
    expect(director.engineFrozen).toBe(false);
    expect(director.allowCardPlay('barracks_1', 7, 0)).toEqual({ col: 7, row: 0 });
    for (const u of state.units) u.isDead = true; // the board is clear, but waves are still to come
    frame(); frame(1);
    expect(host.forceVictory).not.toHaveBeenCalled();
    expect(director.isFinished).toBe(false);
  });

  it('frames the mid-fight unlock once it reaches the hand', () => {
    playBeats();
    const ring = (director as unknown as { ui: { slotRing: { visible: boolean } } }).ui.slotRing;
    frame();
    expect(ring.visible).toBe(false);
    state.bottomPlayer.hand.slots[3] = { card: { id: TUTORIAL_NEW_CARD } } as never;
    frame();
    expect(ring.visible).toBe(true);
    frame(5);
    expect(ring.visible).toBe(false);
  });

  it('engine settles without the analytics notice: WIN stamp, then leaves by itself', () => {
    playBeats();
    (state as { phase: GamePhase }).phase = GamePhase.GameOver;
    frame(); frame(0.6);
    expect(host.forceVictory).toHaveBeenCalledTimes(1);
    expect(director.isFinished).toBe(true);
    expect(host.finish).not.toHaveBeenCalled();
    frame(1.5);
    expect(host.finish).toHaveBeenCalledTimes(1);
  });

  it('falls back to the win a while after the last spawn when a straggler never dies', () => {
    config.lastSpawnTick = 1000;
    playBeats();
    runTo(1000 + FREE_SETTLE_TICKS - 1); frame(1);
    expect(host.forceVictory).not.toHaveBeenCalled();
    runTo(1000 + FREE_SETTLE_TICKS); frame(0.6);
    expect(host.forceVictory).toHaveBeenCalledTimes(1);
  });

  it('an idle player in the free fight is frozen on a play-a-card prompt until they play again', () => {
    playBeats();
    (state.bottomPlayer as unknown as { ink: number }).ink = 3;
    state.bottomPlayer.hand.slots[3] = { card: { id: 'scout_1', cardType: CardType.Unit, cost: 2 } } as never;
    frame(FREE_IDLE_PROMPT_SEC - 0.2);
    expect(director.engineFrozen).toBe(false);
    frame(0.3);
    expect(director.engineFrozen).toBe(true);
    // Aimed at the enemy nearest the base (the lowest row), with the affordable unit.
    expect(host.highlightUnitLane).toHaveBeenLastCalledWith(2);
    for (let i = 0; i < 60; i++) frame(1); // it never gives up, and never wins for them
    expect(director.engineFrozen).toBe(true);
    expect((director as unknown as { ghostOn: boolean }).ghostOn).toBe(true);
    expect(host.forceVictory).not.toHaveBeenCalled();
    expect(director.allowCardPlay('scout_1', 5, 1)).toEqual({ col: 5, row: 1 }); // any play lifts it
    frame();
    expect(director.engineFrozen).toBe(false);
    frame(FREE_IDLE_PROMPT_SEC - 0.2);
    expect(director.engineFrozen).toBe(false);
  });

  it('no idle prompt when nothing in hand is affordable — the fight runs on until ink comes in', () => {
    playBeats();
    (state.bottomPlayer as unknown as { ink: number }).ink = 1;
    state.bottomPlayer.hand.slots[3] = { card: { id: 'scout_1', cardType: CardType.Unit, cost: 2 } } as never;
    frame(FREE_IDLE_PROMPT_SEC + 1);
    expect(director.engineFrozen).toBe(false);
    (state.bottomPlayer as unknown as { ink: number }).ink = 2;
    frame();
    expect(director.engineFrozen).toBe(true);
  });

  it('with the analytics notice pending the graduation card shows, and only its button leaves', () => {
    config.footnote = 'We count anonymous stats.';
    playBeats();
    (state as { phase: GamePhase }).phase = GamePhase.GameOver;
    frame(); frame(0.6);
    expect(director.isFinished).toBe(true);
    frame(0.6); frame(0.3);
    const cta = (director as unknown as { ui: { ctaRect: Rect } }).ui.ctaRect;
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
