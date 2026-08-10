// Regression coverage for the 2026-08-10 portrait reveal-grid change (design/game/GACHA_DESIGN.md
// §4.4): a ten-pull's reveal grid was a flat 5×2 wrap in both orientations. Portrait screens are
// narrower, so 5-across squeezed each card to 16% of design width with barely-legible name plates;
// portrait ten-pulls now lay out a 3/4/3 "diamond" instead (widest row only 4 cards → each card
// grows ~1/4), while landscape stays the original flat 5-wide wrap (user explicitly asked to leave
// landscape untouched). Mirrors gachaContentBoundsOrientation.ui.ts's buildGacha(w, h, cb) pattern.
//
// Two layers of coverage: (1) rowSizesFor() in isolation — the pure row-count logic — and (2) the
// actual rendered card positions for a real reveal, so a future refactor of the centring/sizing
// math (not just the row counts) would also be caught.
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { GachaScene, type GachaSceneCallbacks } from '../../src/scenes/GachaScene';
import type { GachaResultEntry } from '../../src/net/ApiClient';

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

function buildGacha(w: number, h: number, cb: Partial<GachaSceneCallbacks> = {}): { scene: GachaScene; w: number } {
  const layout = createLayout(w, h);
  const scene = new GachaScene(layout, new InputManager(), {
    onBack() {},
    getCoins: () => 1000,
    getPity: () => 0,
    getFatePoints: () => 0,
    loadPools: async () => [],
    draw: async () => ({ ok: true, results: [], overflow: { cardMailed: 0, cardCompensatedCoins: 0, equipMailed: 0, equipCompensatedCoins: 0 } }),
    redeemFate: async () => ({ ok: true, granted: 'placeholder' }),
    ...cb,
  });
  return { scene, w: layout.designWidth };
}

function reveal(scene: GachaScene, results: GachaResultEntry[]): void {
  (scene as unknown as { reveal: GachaResultEntry[] | null }).reveal = results;
  (scene as unknown as { render(): void }).render();
}

const tenIdenticalScraps: GachaResultEntry[] = Array.from({ length: 10 }, () => ({
  itemId: 'mat_scrap', rarity: 'common', duplicate: true,
}));

/** Every rendered name-plate label's (x, y), in the order the cards were drawn (0..n-1) —
 *  tree-walk order matches addChild order, and drawResultCard() is called once per result
 *  in results order, so positions[i] is card i regardless of how many share the same text. */
function nameLabelPositions(scene: GachaScene, label: string): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Text && node.text === label) out.push({ x: node.x, y: node.y });
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(scene.container);
  return out;
}

/** Groups consecutive-by-index positions into rows given each row's card count (e.g. [3, 4, 3]). */
function splitRows<T>(items: T[], rowSizes: number[]): T[][] {
  const rows: T[][] = [];
  let i = 0;
  for (const n of rowSizes) { rows.push(items.slice(i, i + n)); i += n; }
  return rows;
}

const avgX = (row: Array<{ x: number }>): number => row.reduce((s, p) => s + p.x, 0) / row.length;

describe('GachaScene — reveal grid rowSizesFor() (2026-08-10: portrait diamond, landscape unchanged)', () => {
  const rowSizesOf = (scene: GachaScene, n: number): number[] =>
    (scene as unknown as { rowSizesFor(n: number): number[] }).rowSizesFor(n);

  it('portrait ten-pull: 3/4/3', () => {
    const { scene } = buildGacha(...PORTRAIT);
    expect(rowSizesOf(scene, 10)).toEqual([3, 4, 3]);
    scene.destroy();
  });

  it('landscape ten-pull: unchanged flat 5/5', () => {
    const { scene } = buildGacha(...LANDSCAPE);
    expect(rowSizesOf(scene, 10)).toEqual([5, 5]);
    scene.destroy();
  });

  it('single pull: one centred card, same in both orientations', () => {
    const { scene: portrait } = buildGacha(...PORTRAIT);
    const { scene: landscape } = buildGacha(...LANDSCAPE);
    expect(rowSizesOf(portrait, 1)).toEqual([1]);
    expect(rowSizesOf(landscape, 1)).toEqual([1]);
    portrait.destroy(); landscape.destroy();
  });

  it('defensive fallback for a count other than 1/10 (draw() never returns one, but rowSizesFor must not throw): flat chunks of 5', () => {
    const { scene } = buildGacha(...PORTRAIT);
    expect(rowSizesOf(scene, 7)).toEqual([5, 2]);
    scene.destroy();
  });
});

describe('GachaScene — reveal grid actual card layout for a real ten-pull', () => {
  it('portrait: cards land in 3 rows of 3/4/3, each row horizontally centred on the design width', () => {
    const { scene, w } = buildGacha(...PORTRAIT);
    reveal(scene, tenIdenticalScraps);
    const positions = nameLabelPositions(scene, t('material.scrap'));
    expect(positions.length).toBe(10);

    const rows = splitRows(positions, [3, 4, 3]);
    const ys = rows.map((r) => { expect(new Set(r.map((p) => p.y)).size).toBe(1); return r[0].y; });
    expect(ys[0]).toBeLessThan(ys[1]); // top-to-bottom order
    expect(ys[1]).toBeLessThan(ys[2]);
    for (const row of rows) expect(avgX(row)).toBeCloseTo(w / 2, 0);
    scene.destroy();
  });

  it('landscape: cards stay in 2 rows of 5/5, each row centred — unchanged from before this feature', () => {
    const { scene, w } = buildGacha(...LANDSCAPE);
    reveal(scene, tenIdenticalScraps);
    const positions = nameLabelPositions(scene, t('material.scrap'));
    expect(positions.length).toBe(10);

    const rows = splitRows(positions, [5, 5]);
    const ys = rows.map((r) => { expect(new Set(r.map((p) => p.y)).size).toBe(1); return r[0].y; });
    expect(ys[0]).toBeLessThan(ys[1]);
    for (const row of rows) expect(avgX(row)).toBeCloseTo(w / 2, 0);
    scene.destroy();
  });

  it('portrait cards are wider than the old flat 16%-of-width sizing (the point of the change)', () => {
    const { scene, w } = buildGacha(...PORTRAIT);
    reveal(scene, tenIdenticalScraps);
    const positions = nameLabelPositions(scene, t('material.scrap'));
    const rows = splitRows(positions, [3, 4, 3]);
    // Adjacent cards in the 4-card middle row are one (cellW + gapX) apart.
    const spacing = rows[1][1].x - rows[1][0].x;
    const oldFlatSpacing = Math.round(w * 0.16) + Math.round(w * 0.02); // pre-change cellW + gapX
    expect(spacing).toBeGreaterThan(oldFlatSpacing);
    scene.destroy();
  });
});
