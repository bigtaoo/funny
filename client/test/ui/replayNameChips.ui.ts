// Name-chip placement — render/GameRenderer/labels.ts (2026-08-26).
//
// Both players are named by a chip on their HP bar: the shared `drawNameChip` helper backs the
// netplay opponent pill (drawOpponentLabel) AND the replay pair (drawReplayNameLabels). The
// placement rules are the whole feature — a chip that lands 4px lower is a chip with the replay
// progress bar drawn through it, which is exactly the bug this file exists to keep out. It was
// caught by hand, on a 3× zoom of a screenshot; these are the same measurements, automated.
//
// Harness: the pixiHeadless adapter from vitest.ui.config.ts (same as gameScenes.ui.ts) — real
// PIXI tree, no WebGL. Geometry only, no pixels.

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { ReplayScene } from '../../src/scenes/ReplayScene';
import { GameRenderer } from '../../src/render/GameRenderer';
import { createLocalMatch } from '../../src/app/matchEngine';
import type { Replay } from '../../src/game';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const PORTRAIT: [number, number] = [800, 1280];
const LANDSCAPE: [number, number] = [1280, 800];
const SEED = 0x1234abcd;

const LOCAL = 'AtkAlice';
const ENEMY = 'DefBob';

/** The gap drawNameChip's callers leave between a chip and the HP bar it hangs off. */
const CHIP_GAP = 12;
/** Rounded-rect stroke + integer rounding wobble; every edge assertion allows this much. */
const EPS = 2;

interface Rect { x: number; y: number; w: number; h: number }

/** Do two rects share any area? (`EPS` slack so a touching edge doesn't read as a collision.) */
function overlaps(a: Rect, b: Rect): boolean {
  return a.x + a.w > b.x + EPS && b.x + b.w > a.x + EPS
      && a.y + a.h > b.y + EPS && b.y + b.h > a.y + EPS;
}

function recordReplay(frames: number): Replay {
  const { engine, buildReplay } = createLocalMatch({ seed: SEED });
  for (let i = 0; i < frames; i++) engine.tick(1 / 30);
  return buildReplay(null);
}

function replayWithNames(): Replay {
  const replay = recordReplay(30);
  replay.meta = { ...(replay.meta ?? {}), players: { bottom: LOCAL, top: ENEMY } };
  return replay;
}

/**
 * The chip carrying `name`, as a rect. drawNameChip adds its background and its label as an
 * adjacent pair (`addChild(bg, label)`), so the background is the label's immediate previous
 * sibling — and the background, not the text, is what the placement rules are written against.
 */
function chipRect(root: PIXI.Container, name: string): Rect {
  const idx = root.children.findIndex((c) => c instanceof PIXI.Text && c.text === name);
  expect(idx).toBeGreaterThan(0);
  const bg = root.children[idx - 1]!;
  expect(bg).toBeInstanceOf(PIXI.Graphics);
  const b = bg.getBounds();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

describe('replay name chips — one per HP bar', () => {
  for (const [label, size] of [['landscape', LANDSCAPE], ['portrait', PORTRAIT]] as const) {
    describe(label, () => {
      function build(): { scene: any; enemyHp: Rect; playerHp: Rect; root: PIXI.Container } {
        const scene = new ReplayScene(
          createLayout(...size), new InputManager(), replayWithNames(), { onExit() {} },
        ) as any;
        scene.update(1 / 30);
        const core = scene.renderer.core;
        return {
          scene,
          enemyHp: core.hudView.getEnemyHpRect(),
          playerHp: core.hudView.getPlayerHpRect(),
          root: core.container,
        };
      }

      it('the enemy chip sits just left of the top-strip HP bar, clear of the progress bar', () => {
        const { scene, enemyHp, root } = build();
        const chip = chipRect(root, ENEMY);
        const topR = scene.layout.hudTopRect;

        // Right edge exactly CHIP_GAP before the bar — same as netplay's opponent pill.
        expect(chip.x + chip.w).toBeCloseTo(enemyHp.x - CHIP_GAP, -0.5);
        // Inside the top strip…
        expect(chip.y).toBeGreaterThanOrEqual(topR.y - EPS);
        expect(chip.y + chip.h).toBeLessThanOrEqual(topR.y + topR.h + EPS);
        // …and entirely above ReplayScene's progress bar, which is drawn ON TOP of the renderer
        // and runs the width of the board: overlap here means a chip with a red line through it.
        expect(chip.y + chip.h).toBeLessThanOrEqual(scene.barY);
        // Vertically it still reads as belonging to the bar it labels.
        expect(chip.y).toBeLessThan(enemyHp.y + enemyHp.h);
        expect(chip.y + chip.h).toBeGreaterThan(enemyHp.y);

        scene.destroy();
      });

      it('the viewpoint chip hangs off our own HP bar without colliding with it', () => {
        const { scene, playerHp, root } = build();
        const chip = chipRect(root, LOCAL);
        const strip = scene.layout.hudBottomLeftRect;

        // Never overlapping the bar (whichever of the two placements it took), never off-screen,
        // and never floating up over the board — it belongs to the bottom strip's own band.
        expect(overlaps(chip, playerHp)).toBe(false);
        expect(chip.x).toBeGreaterThanOrEqual(0);
        expect(chip.x + chip.w).toBeLessThanOrEqual(scene.layout.designWidth);
        expect(chip.y).toBeGreaterThanOrEqual(strip.y - EPS);
        expect(chip.y + chip.h).toBeLessThanOrEqual(strip.y + strip.h + EPS);

        if (chip.x + chip.w <= playerHp.x) {
          // Left-of-the-bar placement (the preferred one): CHIP_GAP away, centred on the bar.
          expect(chip.x + chip.w).toBeCloseTo(playerHp.x - CHIP_GAP, -0.5);
          expect(chip.y + chip.h / 2).toBeCloseTo(playerHp.y + playerHp.h / 2, -0.5);
        } else {
          // Fallback (landscape, where the column is only ~50px wider than the bar): stacked
          // above the bar, right-aligned to it so name/ink/hearts read as one column, and inside
          // the info column proper (in portrait the bar itself sits outside that rect, board-
          // centred, which is why this is asserted only on the branch that stays in the column).
          expect(chip.y + chip.h).toBeLessThanOrEqual(playerHp.y);
          expect(chip.x + chip.w).toBeCloseTo(playerHp.x + playerHp.w, -0.5);
          expect(chip.x).toBeGreaterThanOrEqual(strip.x - EPS);
          expect(chip.x + chip.w).toBeLessThanOrEqual(strip.x + strip.w + EPS);
        }

        scene.destroy();
      });
    });
  }
});

// The netplay pill is the chip these two were modelled on, and `drawNameChip` was extracted OUT
// of it — so its own geometry has to be exactly what it was: the surrender button's vertical band
// (not the strip's), CHIP_GAP before the enemy HP bar, and the profile-tap region tightened to
// the pill. A drift here is a live-match regression paid for by a replay-only feature.
describe('netplay opponent chip — geometry the shared helper must preserve', () => {
  it('keeps the surrender-button band and tightens the profile tap region to itself', () => {
    const { engine } = createLocalMatch({ seed: SEED });
    const renderer = new GameRenderer(
      engine, createLayout(...LANDSCAPE), new InputManager(),
      /* netEnabled */ true, /* spectator */ false,
      { opponent: { name: 'RivalRon', publicId: '123456789' } },
    ) as any;
    renderer.init();

    const core = renderer.core;
    const surrender = core.hudView.getSurrenderRect();
    const enemyHp = core.hudView.getEnemyHpRect();
    const chip = chipRect(core.container, 'RivalRon');

    expect(surrender.h).toBeGreaterThan(0); // a live match shows the button this band comes from
    expect(chip.y).toBeCloseTo(surrender.y, -0.5);
    expect(chip.h).toBeCloseTo(surrender.h, -0.5);
    expect(chip.x + chip.w).toBeCloseTo(enemyHp.x - CHIP_GAP, -0.5);

    // The tap region is the pill, not the whole left half of the strip it used to be.
    const tap = core.hudView.getEnemyInfoRect();
    expect(tap.x).toBeCloseTo(chip.x, -0.5);
    expect(tap.w).toBeCloseTo(chip.w, -0.5);

    renderer.destroy();
  });
});
