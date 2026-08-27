// Batch 8 (design/product/tab-icon-art-prompts-batch8.md): `siege`/`crit`/`critmult` got art, so
// `affixIconKind` returns a kind for them instead of null and their lines in the detail modal are
// indented behind an icon like every other affix. Before this, an item rolling a siege or crit affix
// showed a bare text line flush against the panel edge, sitting under iconned neighbours.
//
// Asserted through GEOMETRY, not through the icon node: under the headless PIXI adapter an ink icon's
// texture never decodes, so `buildIcon` returns an empty container and "is there an icon" is not
// observable in the tree. What IS observable is the thing the icon changes about the layout — the
// affix line starts 19px further right when one is drawn (detail.ts's `tx`) — and that shifts with
// the icon lookup, so it fails if `affixIconKind` goes back to returning null for these three.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { EquipmentScene, type EquipmentCallbacks } from '../../src/scenes/EquipmentScene';
import { makeNewSave } from '../../src/game/meta/SaveData';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/** Every affix id this test puts on the item — one already-iconned control plus the three new ones. */
const AFFIXES = [
  { id: 'm_hp', value: 10 },        // shipped icon since batch 7 — the control
  { id: 's_siege', value: 5 },      // batch 8
  { id: 'm_crit', value: 6 },       // batch 8
  { id: 's_critmult', value: 20 },  // batch 8
];

function openDetailOn(affixes: { id: string; value: number }[]): PIXI.Container {
  const save = makeNewSave();
  save.equipmentInv['inst_1'] = { id: 'inst_1', defId: 'ar_cardstock', rarity: 'epic', level: 0, affixes };
  const cb: EquipmentCallbacks = {
    onBack() {},
    getSave: () => save,
    craft: async () => ({ ok: true }),
    enhance: async () => ({ ok: true, success: true, level: 1 }),
    salvage: async () => ({ ok: true }),
    equip: async () => ({ ok: true }),
    reforge: async () => ({ ok: true }),
    activeCardInstanceId: '',
  };
  const scene = new EquipmentScene(createLayout(390, 844), new InputManager(), cb);
  (scene as unknown as { detail: { openDetail(id: string): void } }).detail.openDetail('inst_1');
  return scene.container;
}

/** x of each affix line, keyed by affix id (matched via its own translated text). */
function affixLineXs(container: PIXI.Container): Map<string, number> {
  const wanted = new Map(AFFIXES.map((a) => {
    // affixDesc's main-affix branch scales the value by the enhancement multiplier; at level 0 that
    // is ×1, so the rendered string is the plain template with the rolled value substituted.
    const text = t(`affix.${a.id}` as never, { v: a.value } as never);
    return [text, a.id];
  }));
  const out = new Map<string, number>();
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Text && wanted.has(node.text)) out.set(wanted.get(node.text)!, node.x);
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return out;
}

describe('EquipmentScene detail modal — affix rows all sit behind an icon', () => {
  it('indents the siege/crit/crit-damage lines exactly as far as an already-iconned affix', () => {
    const xs = affixLineXs(openDetailOn(AFFIXES));
    expect([...xs.keys()].sort()).toEqual(['m_crit', 'm_hp', 's_critmult', 's_siege']);
    const control = xs.get('m_hp')!;
    for (const id of ['s_siege', 'm_crit', 's_critmult']) {
      expect(xs.get(id), `${id} line x`).toBe(control);
    }
  });
});
