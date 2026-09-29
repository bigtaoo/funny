// Regression coverage for two German overflows in the equipment modals (2026-09-29), both drawn with
// no width limit at all rather than shrunk:
//   - detail modal: the protect-stone line ("Schutzstein ×0 (Material bei Fehlschlag behalten)") and
//     the +7/+8 demote warning ran past the panel's right edge and were cut off there;
//   - reforge material picker: "Abbrechen" sat in a fixed 60-wide cancel button, both ends outside it.
// The headless adapter measures 7px per character, which is already enough for both German strings
// to overflow here, so no label mocking is needed.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { EquipmentScene, type EquipmentCallbacks } from '../../src/scenes/EquipmentScene';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { SaveData } from '../../src/game/meta/SaveData';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('de', memStore, ['zh', 'en', 'de']);

interface Rect { x: number; y: number; w: number; h: number; }
interface Hit { rect: Rect; fn: () => void; owner?: string }
interface SceneInternals {
  core: { hitRects: Hit[]; modalHits: Hit[]; modalOpen: boolean; bodyLayer: PIXI.Container; modalLayer: PIXI.Container; modalPanelRoot: PIXI.Container | null };
}

function buildScene(targetLevel: number): EquipmentScene {
  const save: SaveData = makeNewSave('acc_test');
  save.wallet.coins = 100000;
  save.materials = { scrap: 100, lead: 100, binding: 100 };
  save.equipmentInv = {
    target: { id: 'target', defId: 'wp_highlighter', rarity: 'epic', level: targetLevel, affixes: [], locked: false },
    fuel: { id: 'fuel', defId: 'wp_marker', rarity: 'rare', level: 0, affixes: [], locked: false },
  };
  const cb: EquipmentCallbacks = {
    onBack() {},
    getSave: () => save,
    craft: async () => ({ ok: true }),
    enhance: async () => ({ ok: true, success: true, level: targetLevel + 1 }),
    salvage: async () => ({ ok: true }),
    equip: async () => ({ ok: true }),
    reforge: async () => ({ ok: true }),
    activeCardInstanceId: '',
  };
  return new EquipmentScene(createLayout(360, 640), new InputManager(), cb);
}

function texts(root: PIXI.Container): PIXI.Text[] {
  const out: PIXI.Text[] = [];
  const walk = (n: PIXI.Container): void => {
    if (n instanceof PIXI.Text) out.push(n);
    for (const c of n.children) walk(c as PIXI.Container);
  };
  walk(root);
  return out;
}

const inside = (r: Rect, x: number, y: number): boolean => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** Taps the target cell's "Verstärken", which opens its detail modal. */
function openTargetDetail(scene: EquipmentScene): SceneInternals {
  const internals = scene as unknown as SceneInternals;
  const enhance = texts(internals.core.bodyLayer).filter((l) => l.text === t('equip.enhance'));
  const hit = enhance
    .map((l) => { const p = l.getGlobalPosition(); return internals.core.hitRects.find((h) => h.owner === 'target' && inside(h.rect, p.x, p.y)); })
    .find((h) => h !== undefined)!;
  hit.fn();
  expect(internals.core.modalOpen).toBe(true);
  return internals;
}

describe('EquipmentScene modals — German sentences stay inside their panel', () => {
  it('detail modal wraps the protect and demote lines inside the panel, and nothing below overlaps them', () => {
    // Level 7: the demote warning only shows on +7/+8 attempts.
    const scene = buildScene(7);
    const internals = openTargetDetail(scene);
    const root = internals.core.modalPanelRoot!;
    // The panel graphic itself (first child) — root's own bounds would grow to hold an overflowing label.
    const panel = (root.children[0] as PIXI.Container).getBounds();
    const labels = texts(root);
    const protect = labels.find((l) => l.text.startsWith('Schutzstein'))!;
    const demote = labels.find((l) => l.text.includes('Stufe zu verlieren'))!;
    expect(protect).toBeDefined();
    expect(demote).toBeDefined();
    for (const l of labels) {
      const b = l.getBounds();
      expect(b.x + b.width, `"${l.text}" ends inside the panel`).toBeLessThanOrEqual(panel.x + panel.width + 0.5);
    }
    // Wrapped, the protect line is more than one line tall — and the confirm button starts below it.
    const confirm = labels.find((l) => l.text === t('equip.enhance'))!;
    const pb = protect.getBounds();
    expect(pb.bottom).toBeLessThanOrEqual(confirm.getBounds().top);
    // The section's 18px line pitch is a little under a text box's height, so neighbouring one-line
    // rows already overlap by a sliver (rate → demote). The wrapped demote line may not eat into the
    // cost row by more than that.
    const db = demote.getBounds();
    const rate = labels.find((l) => l.text.startsWith('Erfolg'))!;
    const pitchOverlap = rate.getBounds().bottom - db.top;
    const costTop = Math.min(...labels.filter((l) => l.text.startsWith(t('equip.cost'))).map((l) => l.getBounds().top));
    expect(db.bottom - costTop).toBeLessThanOrEqual(pitchOverlap + 0.5);
    expect(db.height, 'the demote warning wrapped').toBeGreaterThan(rate.getBounds().height * 1.5);
    expect(pb.height, 'the protect line wrapped').toBeGreaterThan(rate.getBounds().height * 1.5);
    // The whole wrapped protect label sits inside the toggle's tap target.
    const pc = { x: pb.x + pb.width / 2, y: pb.bottom - 1 };
    expect(internals.core.modalHits.some((h) => inside(h.rect, pc.x, pc.y) && h.rect.h < panel.height)).toBe(true);
    scene.destroy();
  });

  it('reforge picker sizes its cancel button to "Abbrechen"', () => {
    const scene = buildScene(2);
    const internals = scene as unknown as SceneInternals;
    // At 7px per character "Umschmieden" still fits on the cell, so reforge is a cell button here.
    const reforge = texts(internals.core.bodyLayer).find((l) => l.text === t('equip.reforge'))!;
    const rp = reforge.getGlobalPosition();
    internals.core.hitRects.find((h) => h.owner === 'target' && inside(h.rect, rp.x, rp.y))!.fn();
    expect(internals.core.modalOpen).toBe(true);
    const cancel = texts(internals.core.modalLayer).find((l) => l.text === t('equip.cancel'))!;
    expect(cancel).toBeDefined();
    const b = cancel.getBounds();
    const hit = internals.core.modalHits.find((h) => inside(h.rect, b.x + b.width / 2, b.y + b.height / 2))!;
    expect(hit.rect.x).toBeLessThanOrEqual(b.x);
    expect(hit.rect.x + hit.rect.w).toBeGreaterThanOrEqual(b.x + b.width);
    scene.destroy();
  });
});
