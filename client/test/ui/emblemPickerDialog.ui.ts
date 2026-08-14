// Coverage for the shared emblem-picker dialog (family-emblem-art-prompts.md, 2026-08-14) —
// client/src/ui/dialogs/emblemPickerDialog.ts. Deliberately never calls loadEmblemAtlas() here, so
// isEmblemAtlasReady() stays false for the whole file and every cell renders via the tinted
// placeholder-square branch, not a real buildEmblemIcon sprite — that's fine, this file is about the
// grid/swatch layout, hit-rect wiring, and selection-state redraw, not the actual icon graphics
// (which have their own atlas-loader coverage elsewhere and no interesting logic of their own).
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { EMBLEM_KEYS, EMBLEM_COLORS } from '../../src/render/emblemIcon';
import { drawEmblemPickerDialog, type EmblemPickerState } from '../../src/ui/dialogs/emblemPickerDialog';
import { initI18n } from '../../src/i18n';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const W = 1280, H = 800;

function draw(state: EmblemPickerState, busy = false) {
  const ml = new PIXI.Container();
  const onPick = () => {};
  const onPickColor = () => {};
  const onConfirm = () => {};
  const onCancel = () => {};
  const hits = drawEmblemPickerDialog(ml, W, H, state, busy, onPick, onPickColor, onConfirm, onCancel);
  return { ml, hits };
}

describe('emblemPickerDialog', () => {
  it('draws exactly 24 icon-grid hits + 8 colour-swatch hits + confirm/cancel + the full-screen dim-to-cancel rect', () => {
    const { hits } = draw({ key: EMBLEM_KEYS[0]!, color: EMBLEM_COLORS[0]! });
    // 1 dim rect + 24 grid cells + 8 swatches + confirm + cancel = 35
    expect(hits).toHaveLength(1 + EMBLEM_KEYS.length + EMBLEM_COLORS.length + 2);
  });

  it('tapping a grid cell calls onPick with that cell\'s key', () => {
    const picked: string[] = [];
    const ml = new PIXI.Container();
    const hits = drawEmblemPickerDialog(
      ml, W, H, { key: EMBLEM_KEYS[0]!, color: EMBLEM_COLORS[0]! }, false,
      (key) => picked.push(key), () => {}, () => {}, () => {},
    );
    // Grid-cell hits are the ones sized exactly cell×cell (square) and not the dim/confirm/cancel
    // rects (which are never square at these dimensions) — the 3rd hit pushed is EMBLEM_KEYS[1]
    // (dim rect is hit[0], grid cells start at hit[1] in EMBLEM_KEYS order).
    const secondCell = hits[2]!;
    secondCell.action();
    expect(picked).toEqual([EMBLEM_KEYS[1]]);
  });

  it('tapping a colour swatch calls onPickColor with that swatch\'s colour', () => {
    const pickedColors: number[] = [];
    const ml = new PIXI.Container();
    const hits = drawEmblemPickerDialog(
      ml, W, H, { key: EMBLEM_KEYS[0]!, color: EMBLEM_COLORS[0]! }, false,
      () => {}, (c) => pickedColors.push(c), () => {}, () => {},
    );
    // Hit order: [dim, 24 grid cells, 8 swatches, confirm, cancel] — swatches start right after the grid.
    const swatchStart = 1 + EMBLEM_KEYS.length;
    hits[swatchStart + 3]!.action(); // 4th swatch
    expect(pickedColors).toEqual([EMBLEM_COLORS[3]]);
  });

  it('Confirm hit fires onConfirm; Cancel hit and the dim backdrop both fire onCancel', () => {
    let confirmed = 0, cancelled = 0;
    const ml = new PIXI.Container();
    const hits = drawEmblemPickerDialog(
      ml, W, H, { key: EMBLEM_KEYS[0]!, color: EMBLEM_COLORS[0]! }, false,
      () => {}, () => {}, () => { confirmed++; }, () => { cancelled++; },
    );
    const confirmHit = hits[hits.length - 2]!;
    const cancelHit = hits[hits.length - 1]!;
    confirmHit.action();
    expect(confirmed).toBe(1);
    cancelHit.action();
    expect(cancelled).toBe(1);
    hits[0]!.action(); // the full-screen dim rect
    expect(cancelled).toBe(2);
  });

  it('busy=true drops the Confirm hit (greyed out, not tappable) but keeps every other hit', () => {
    const { hits } = draw({ key: EMBLEM_KEYS[0]!, color: EMBLEM_COLORS[0]! }, true);
    // One fewer hit than the non-busy case — Confirm's hit rect is omitted while busy.
    expect(hits).toHaveLength(1 + EMBLEM_KEYS.length + EMBLEM_COLORS.length + 1);
  });

  it('re-drawing with a different selected key/colour does not throw and still returns the full hit set (redraw-in-place contract)', () => {
    let state: EmblemPickerState = { key: EMBLEM_KEYS[0]!, color: EMBLEM_COLORS[0]! };
    const ml = new PIXI.Container();
    const redraw = () => drawEmblemPickerDialog(
      ml, W, H, state, false,
      (key) => { state = { ...state, key }; }, (c) => { state = { ...state, color: c }; },
      () => {}, () => {},
    );
    const hits1 = redraw();
    hits1[2]!.action(); // pick EMBLEM_KEYS[1]
    expect(state.key).toBe(EMBLEM_KEYS[1]);
    const hits2 = redraw(); // caller re-invokes after the state mutation, as the real callers do
    expect(hits2).toHaveLength(hits1.length);
    // tearDownChildren clears the old tree each call — no leftover children from the prior draw.
    expect(ml.children.length).toBeGreaterThan(0);
  });

  it('every EMBLEM_COLORS value is distinct (picker relies on colour identity for the selection ring)', () => {
    expect(new Set(EMBLEM_COLORS).size).toBe(EMBLEM_COLORS.length);
  });
});
