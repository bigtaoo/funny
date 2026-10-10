// The campaign's "build a defense first" nudge (ONBOARDING_DESIGN §12) on a real ch1_lv1 engine:
// it waits for its tick, shows the strip + ghost demo only to a player with no building, ends for good
// on the first building or after 20 s, steps aside while the battle is paused, and aims at the lane
// under most pressure.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import type * as PIXI from 'pixi.js-legacy';
import { initI18n, t } from '../../src/i18n';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { GameRenderer } from '../../src/render/GameRenderer';
import { pressureLane, type BuildHintOutcome } from '../../src/render/GameRenderer/buildHint';
import { createLocalMatch } from '../../src/app/matchEngine';
import { CardType, Side, getLevel } from '../../src/game';
import { BOTTOM_BUILDING_ROW } from '@nw/engine/config';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const AT_TICK = 180;

function build(atTick = AT_TICK) {
  const { engine } = createLocalMatch({ level: getLevel('ch1_lv1')! });
  const input = new InputManager();
  const renderer = new GameRenderer(engine, createLayout(800, 1280), input);
  const events: Array<[BuildHintOutcome, number]> = [];
  renderer.setBuildHint({ atTick, onEvent: (o, tick) => events.push([o, tick]) });
  renderer.init();
  const step = (frames: number) => { for (let i = 0; i < frames; i++) renderer.update(1 / 30); };
  return { engine, renderer, events, step };
}

const hintNode = (r: GameRenderer) => r.container.children.find((c) => c.name === 'buildHint') as PIXI.Container | undefined;

function texts(node: PIXI.Container): string[] {
  const out: string[] = [];
  const walk = (n: PIXI.Container) => {
    const tx = (n as unknown as { text?: unknown }).text;
    if (typeof tx === 'string') out.push(tx);
    for (const c of n.children) walk(c as PIXI.Container);
  };
  walk(node);
  return out;
}

/** Plays the first building card in hand onto `col`. */
function placeBuilding(engine: ReturnType<typeof build>['engine'], col: number): void {
  const slot = engine.state.bottomPlayer.hand.slots.findIndex((s) => s?.card.cardType === CardType.Building);
  expect(slot, 'ch1_lv1 opening hand holds a building card').toBeGreaterThanOrEqual(0);
  engine.playCard(slot, col);
}

describe('battle — "build a defense first" hint', () => {
  it('appears at its tick for a player with no building, with the instruction line', () => {
    const { engine, renderer, events, step } = build();
    step(AT_TICK - 10);
    expect(hintNode(renderer)).toBeUndefined();
    step(20);
    const node = hintNode(renderer)!;
    expect(node.visible).toBe(true);
    expect(texts(node)).toEqual(expect.arrayContaining([t('hint.build.title'), t('hint.build.body')]));
    expect(events.map((e) => e[0])).toEqual(['shown']);
    expect(events[0]![1]).toBeGreaterThanOrEqual(AT_TICK);
    expect(engine.state.board.buildings.size).toBe(0); // it never plays for the player
    renderer.destroy();
  });

  it('ends for good once a building lands', () => {
    const { engine, renderer, events, step } = build();
    step(AT_TICK + 10);
    placeBuilding(engine, 4);
    step(3);
    expect(hintNode(renderer)!.visible).toBe(false);
    expect(events.map((e) => e[0])).toEqual(['shown', 'built']);
    step(60);
    expect(hintNode(renderer)!.visible).toBe(false);
    expect(events).toHaveLength(2);
    renderer.destroy();
  });

  it('never shows — and reports nothing — when the player built before it was due', () => {
    const { engine, renderer, events, step } = build();
    step(30);
    placeBuilding(engine, 7);
    step(AT_TICK + 60);
    expect(hintNode(renderer)).toBeUndefined();
    expect(events).toEqual([]);
    renderer.destroy();
  });

  it('expires after 20 s when ignored', () => {
    const { renderer, events, step } = build(30);
    step(40);
    expect(events.map((e) => e[0])).toEqual(['shown']);
    step(30 * 21);
    expect(hintNode(renderer)!.visible).toBe(false);
    expect(events.map((e) => e[0])).toEqual(['shown', 'expired']);
    renderer.destroy();
  });

  it('hides while the surrender dialog pauses the battle', () => {
    const { renderer, step } = build(30);
    step(40);
    const hud = (renderer as unknown as { core: { hudView: object } }).core.hudView;
    Object.defineProperty(hud, 'isPaused', { get: () => true, configurable: true });
    step(2);
    expect(hintNode(renderer)!.visible).toBe(false);
    Object.defineProperty(hud, 'isPaused', { get: () => false, configurable: true });
    step(2);
    expect(hintNode(renderer)!.visible).toBe(true);
    renderer.destroy();
  });
});

describe('pressureLane — where the ghost points', () => {
  it('with no enemy on the board: the buildable lane nearest the centre', () => {
    const { engine } = build();
    expect(pressureLane(engine.state, Side.Bottom, BOTTOM_BUILDING_ROW)).toBe(4);
  });

  it('the lane whose nearest enemy is closest to our build row, skipping occupied slots', () => {
    const { engine, step } = build();
    step(AT_TICK + 60); // ch1_lv1's first waves walk down cols 4 and 7
    const lane = pressureLane(engine.state, Side.Bottom, BOTTOM_BUILDING_ROW);
    const enemyCols = [...engine.state.board.units.values()].filter((u) => !u.isDead && u.side === Side.Top).map((u) => u.col);
    expect(enemyCols).toContain(lane);
    placeBuilding(engine, lane);
    step(2);
    expect(pressureLane(engine.state, Side.Bottom, BOTTOM_BUILDING_ROW)).not.toBe(lane);
  });
});
