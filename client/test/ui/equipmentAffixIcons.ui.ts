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
import { zh } from '../../src/i18n/locales/zh';

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
  // The MODAL layer, not the whole scene: the inventory grid cell behind it lists the same affix
  // strings (text-only — that cell draws no icons at all, by design), so a whole-tree walk reads
  // whichever copy it happens to hit first and the x it compares is the grid's, not the modal's.
  return (scene as unknown as { core: { modalLayer: PIXI.Container } }).core.modalLayer;
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

/**
 * Every affix a player can actually see, derived from the i18n table rather than hand-listed: an
 * `affix.<id>` key exists exactly when that affix is rollable and shown (the four ids in the
 * engine's AFFIX_FIELD_MAP that no pool rolls — lifesteal/regen/matdrop/stamina — deliberately have
 * neither a key nor art, see design/product/tab-icon-art-prompts-batch8.md). So this list grows the
 * day one of them goes live, and the case below then fails until its icon lands.
 */
const VISIBLE_AFFIX_IDS = Object.keys(zh)
  .filter((k) => k.startsWith('affix.'))
  .map((k) => k.slice('affix.'.length));

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

describe('EquipmentScene detail modal — no player-visible affix is left without art', () => {
  // The forward-looking half of the same contract: the case above pins the three ids batch 8 fixed,
  // this one pins the RULE — every affix with copy has a glyph. It is the gate the batch-7 sweep
  // lacked: that sweep could only see kinds already being drawn, so `siege`/`crit`/`critmult` (never
  // drawn at all) went unnoticed for five batches.
  //
  // The baseline is a synthetic id that can never have an icon (`affixDesc` falls back to
  // "<id> +<n>" for an unknown key), so the comparison is anchored rather than relative: if every
  // affix lost its icon at once, the assertion still fails instead of finding them all equal and
  // calling it consistent. The un-iconned x is `mx + 16`, not 0 — the panel's own left inset — which
  // is why "x === 0" cannot stand in for "no icon" here.
  const NO_ICON_ID = 'zz_no_such_affix';

  it('indents every affix line that has translated copy, past an icon-less baseline', () => {
    const affixes = [...VISIBLE_AFFIX_IDS, NO_ICON_ID].map((id) => ({ id, value: 5 }));
    const container = openDetailOn(affixes);
    const xs = new Map<string, number[]>();
    const walk = (node: PIXI.Container): void => {
      if (node instanceof PIXI.Text) {
        const seen = xs.get(node.text) ?? [];
        seen.push(node.x);
        xs.set(node.text, seen);
      }
      for (const c of node.children) walk(c as PIXI.Container);
    };
    walk(container);

    const baseline = xs.get(`${NO_ICON_ID} +5`);
    expect(baseline, 'icon-less baseline line was not drawn').toBeDefined();
    const flushLeft = baseline![0]!;

    const missing: string[] = [];
    for (const id of VISIBLE_AFFIX_IDS) {
      const line = t(`affix.${id}` as never, { v: 5 } as never);
      const drawn = xs.get(line);
      // A line that isn't drawn at all is a different failure (the modal clipping its own list);
      // fail loudly rather than silently passing over it. Two ids can share one string (`m_atk` and
      // `s_atk` read the same), so every occurrence of that string has to clear the baseline.
      if (!drawn) missing.push(`${id} (line not drawn: "${line}")`);
      else if (drawn.some((x) => x <= flushLeft)) missing.push(`${id} (flush with the icon-less baseline)`);
    }
    expect(missing).toEqual([]);
  });
});
