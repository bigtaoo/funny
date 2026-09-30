// An inventory cell's action buttons may only carry labels that read at the legibility floor
// (src/scenes/EquipmentScene/cellActionSplit.ts). They used to share the cell's width equally and
// `scale.set` any label wider than its share, which the 2026-09-28 German sweep caught on every
// cell: "Verstärken" at 0.76 and "Umschmieden" at 0.69 of the 20px floor, three buttons to a
// 285px portrait cell.
//
// The numbers here are the real ones, not the headless harness's 7px per character: the UI font is
// monospace at 0.55 em (see auctionCellInfoWidth.test.ts for how that was measured), so a button
// label at the portrait floor of 20 design px costs 11 px per character, and the narrowest portrait
// cell in the sweep leaves 285 - 2*8 = 269 px for the button row.
import { describe, it, expect } from 'vitest';
import { initI18n, t, setLocale } from '../src/i18n';
import { splitCellActions } from '../src/scenes/EquipmentScene/cellActionSplit';
import type { CellAction } from '../src/scenes/EquipmentScene/types';
import type { TranslationKey } from '../src/i18n';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const INNER_W = 269;
const PX_PER_CHAR = 11;
/** Full-width (CJK) characters are one em, twice a latin cell. */
const measure = (s: string): number => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e7f ? 2 : 1) * PX_PER_CHAR, 0);

const ALL = ['enhance', 'equip', 'reforge', 'salvage', 'salvageAll'] as const;
const actions = (keys: readonly string[]): CellAction[] => keys.map((key) => ({
  key, label: t(`equip.${key}` as TranslationKey), icon: 'check', fill: 0, stroke: 0, fn: () => {},
}));

describe('splitCellActions', () => {
  for (const lang of ['en', 'de', 'zh'] as const) {
    for (let n = 1; n <= ALL.length; n++) {
      it(`${lang}, ${n} action(s): every button's label fits at the floor, and nothing is dropped`, () => {
        setLocale(lang);
        const all = actions(ALL.slice(0, n));
        const r = splitCellActions(all, INNER_W, measure);
        const labels = [...r.shown.map((a) => a.label), ...(r.overflow.length > 0 ? [t('equip.moreActions')] : [])];
        for (const l of labels) expect(measure(l) + 4, `${lang} "${l}" in ${r.buttonW.toFixed(1)}`).toBeLessThanOrEqual(r.buttonW);
        const slots = labels.length;
        expect(slots * r.buttonW + 5 * (slots - 1)).toBeCloseTo(INNER_W, 6);
        expect([...r.shown, ...r.overflow].map((a) => a.key).sort()).toEqual(all.map((a) => a.key).sort());
        // Shown keeps the priority order instanceActions hands in.
        expect(r.shown.map((a) => all.indexOf(a))).toEqual([...r.shown.map((a) => all.indexOf(a))].sort((x, y) => x - y));
      });
    }
  }

  it('leaves a row that already fits exactly as it was (English Enhance / Equip / Reforge)', () => {
    setLocale('en');
    const r = splitCellActions(actions(['enhance', 'equip', 'reforge']), INNER_W, measure);
    expect(r.overflow).toEqual([]);
    expect(r.shown.map((a) => a.key)).toEqual(['enhance', 'equip', 'reforge']);
  });

  it('German Verstärken / Anlegen / Umschmieden (the sweep\'s row) keeps Enhance and moves the rest behind More', () => {
    setLocale('de');
    const r = splitCellActions(actions(['enhance', 'equip', 'reforge']), INNER_W, measure);
    expect(r.shown.map((a) => a.key)).toEqual(['enhance']);
    expect(r.overflow.map((a) => a.key)).toEqual(['equip', 'reforge']);
  });

  it('skips an action whose label is too wide rather than giving up on the ones after it', () => {
    const wide: CellAction[] = [
      { key: 'a', label: 'x'.repeat(30), icon: 'check', fill: 0, stroke: 0, fn: () => {} },
      { key: 'b', label: 'Bb', icon: 'check', fill: 0, stroke: 0, fn: () => {} },
      { key: 'c', label: 'Cc', icon: 'check', fill: 0, stroke: 0, fn: () => {} },
    ];
    const r = splitCellActions(wide, INNER_W, measure, 'More');
    expect(r.shown.map((a) => a.key)).toEqual(['b', 'c']);
    expect(r.overflow.map((a) => a.key)).toEqual(['a']);
  });
});
