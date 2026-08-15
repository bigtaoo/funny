/**
 * tutorialMeteorTargetRing.test.ts — regression test for the tutorial spell-beat
 * target ring alignment (2026-08-09).
 *
 * Background: `TutorialDirector`'s Beat 3 (meteor/spell beat) draws a pulsing ring
 * at the spot the setup enemy cluster is supposed to land, to tell the player where
 * to drop the meteor. It used to compute the row as a guessed board percentage
 * (`Math.round(boardRows * 0.72)`), but `ch0_tutorial.json`'s wave has no
 * `board.laneLength` override, so the enemies always spawn and sit at the engine's
 * fixed `TOP_SPAWN_ROW` — 3 rows below the guessed spot. The ring sat over empty
 * board, and a meteor cast on it (2x2 AoE) could miss the actual cluster.
 *
 * The fix anchors the ring directly at `TOP_SPAWN_ROW`. This test drives the
 * director into the spell beat and asserts it queries the layout's coordinate
 * transform with that exact row (not a re-derived guess), and that the ring is
 * placed at whatever screen point that transform returns.
 *
 * Run with: npm test — the default suite's include covers every *.test.ts under test/.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Minimal PIXI stub — only what TutorialDirector/pixiText/sketchUi/hudButton touch ──
vi.mock('pixi.js-legacy', () => {
  class FakeContainer {
    children: unknown[] = [];
    x = 0; y = 0; visible = true; alpha = 1;
    position = { x: 0, y: 0, set(x: number, y?: number): void { this.x = x; this.y = y ?? x; } };
    addChild(...c: unknown[]): unknown { this.children.push(...c); return c[0]; }
    removeChild(c: unknown): void { this.children = this.children.filter((x) => x !== c); }
    removeChildren(): unknown[] { const r = this.children; this.children = []; return r; }
    destroy(): void { /* no-op */ }
  }
  class FakeGraphics extends FakeContainer {
    beginFill(): this { return this; }
    endFill(): this { return this; }
    lineStyle(): this { return this; }
    drawRect(): this { return this; }
    drawRoundedRect(): this { return this; }
    drawEllipse(): this { return this; }
    drawCircle(): this { return this; }
    clear(): this { return this; }
  }
  class FakeText extends FakeContainer {
    text: string;
    style: Record<string, unknown>;
    anchor = { set(): void {} };
    constructor(text = '', style: Record<string, unknown> = {}) { super(); this.text = text; this.style = { ...style }; }
  }
  return {
    Container: FakeContainer,
    Graphics: FakeGraphics,
    Text: FakeText,
    settings: { ADAPTER: {} },
  };
});

import * as PIXI from 'pixi.js-legacy';
import { TutorialDirector, type TutorialHost } from '../../src/render/TutorialDirector';
import { TOP_SPAWN_ROW } from '@nw/engine/config';
import type { ILayout, Rect } from '../../src/layout/ILayout';

function fakeLayout(gridToScreen: (col: number, row: number) => { x: number; y: number }): ILayout {
  const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
  return {
    orientation: 'landscape',
    designWidth: 1920,
    designHeight: 1080,
    cellSize: 70,
    boardRect: rect(660, 0, 1260, 1080),
    handRect: rect(0, 950, 1920, 130),
    cardWidth: 120,
    cardHeight: 160,
    gridToScreen,
  } as unknown as ILayout;
}

function fakeHost(layout: ILayout): TutorialHost {
  return {
    container: new PIXI.Container(),
    layout,
    highlightUnitLane: vi.fn(),
    highlightBuildingLane: vi.fn(),
    clearLaneHighlights: vi.fn(),
    handSlotCenter: () => ({ x: 0, y: 0 }),
    switchToFreePlayDraw: vi.fn(),
    forceVictory: vi.fn(),
    onSkip: vi.fn(),
    onStepChange: vi.fn(),
  } as unknown as TutorialHost;
}

describe('TutorialDirector — spell beat target ring', () => {
  let gridToScreen: ReturnType<typeof vi.fn>;
  let director: TutorialDirector;

  beforeEach(() => {
    gridToScreen = vi.fn((_col: number, _row: number) => ({ x: 999, y: 888 }));
    const layout = fakeLayout(gridToScreen);
    director = new TutorialDirector(fakeHost(layout));
    // Drive the director straight into the spell beat (index 2 of BEATS) without
    // replaying the full orientation → beat1 → beat2 flow — this test targets only
    // the ring placement, not the beat state machine.
    (director as unknown as { phase: string }).phase = 'beat';
    (director as unknown as { beatIndex: number }).beatIndex = 2;
    (director as unknown as { renderBeatPrompt(): void }).renderBeatPrompt();
  });

  it('queries the layout transform with the enemy wave column and TOP_SPAWN_ROW, not a guessed board percentage', () => {
    // col=2 matches the meteor beat's lane (BEATS[2].col in TutorialDirector.ts),
    // which is also ch0_tutorial.json's third wave entry column.
    expect(gridToScreen).toHaveBeenCalledWith(2, TOP_SPAWN_ROW);
  });

  it('never asks for a row derived from boardRect/cellSize (the old 0.72-guess formula)', () => {
    // Regression guard: the old formula was Math.round((boardRect.h / cellSize) * 0.72).
    // With this test's fakeLayout that evaluates to round(1080/70 * 0.72) = 11 — a
    // different row than TOP_SPAWN_ROW (16). Assert that row never appears.
    const guessedOldRow = Math.round((1080 / 70) * 0.72);
    expect(guessedOldRow).not.toBe(TOP_SPAWN_ROW); // sanity: the two formulas actually disagree
    for (const call of gridToScreen.mock.calls) {
      expect(call[1]).not.toBe(guessedOldRow);
    }
  });

  it('places the cluster ring at exactly the point gridToScreen returns, and makes it visible', () => {
    const clusterRing = (director as unknown as { clusterRing: { visible: boolean; position: { x: number; y: number } } }).clusterRing;
    expect(clusterRing.visible).toBe(true);
    expect(clusterRing.position.x).toBe(999);
    expect(clusterRing.position.y).toBe(888);
  });
});
