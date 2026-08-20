// src/logic/slgShop.ts — the shop override form: which effect field each item kind has, and the two
// bounds that differ on purpose (cost must be positive; an effect of 0 is merely useless).
import { describe, expect, it } from 'vitest';
import { EFFECT_FIELD, effectFieldFor, effectInputValue, shopItemInput, shopMetaText } from '../src/logic/slgShop';
import type { SlgShopItem, SlgShopItemOverrideDoc, SlgShopItemRow } from '../src/types';

const stamp = (ms: number): string => `T${ms}`;

const item = (over: Partial<SlgShopItem> = {}): SlgShopItem => ({
  id: 'speedup_1h', kind: 'troop_speedup', cost: 10, description: '1h speedup',
  effect: { duration_sec: 3600 }, ...over,
});

const row = (over: Partial<SlgShopItemRow> = {}): SlgShopItemRow => ({
  id: 'speedup_1h',
  default: item(),
  effective: item({ cost: 12 }),
  doc: null,
  ...over,
});

const overrideDoc = (updatedBy: string): SlgShopItemOverrideDoc =>
  ({ _id: 'speedup_1h', cost: 12, updatedBy, updatedAt: 99 });

describe('EFFECT_FIELD', () => {
  it('gives every item kind an entry, with battle_pass explicitly having none', () => {
    expect(Object.keys(EFFECT_FIELD).sort()).toEqual(['battle_pass', 'protection', 'resource_pack', 'troop_speedup']);
    expect(effectFieldFor('battle_pass')).toBeNull();
  });

  it('names the right field per kind', () => {
    expect(effectFieldFor('troop_speedup')).toEqual({ key: 'duration_sec', label: 'Duration (seconds)' });
    expect(effectFieldFor('protection')).toEqual({ key: 'duration_sec', label: 'Duration (seconds)' });
    expect(effectFieldFor('resource_pack')).toEqual({ key: 'each', label: 'Amount per resource' });
  });
});

describe('effectInputValue', () => {
  it('reads the effective value for the field', () => {
    expect(effectInputValue(row(), { key: 'duration_sec' })).toBe('3600');
  });

  it('is blank when the effective config has no value for it', () => {
    expect(effectInputValue(row(), { key: 'each' })).toBe('');
  });

  it('keeps a real zero', () => {
    expect(effectInputValue(row({ effective: item({ effect: { duration_sec: 0 } }) }), { key: 'duration_sec' })).toBe('0');
  });
});

describe('shopItemInput', () => {
  it('accepts a positive cost and a non-negative effect', () => {
    expect(shopItemInput('troop_speedup', '20', '7200')).toEqual({ ok: true, input: { cost: 20, effect: { duration_sec: 7200 } } });
  });

  it('allows an effect of exactly 0 — useless, but not invalid', () => {
    expect(shopItemInput('resource_pack', '5', '0')).toEqual({ ok: true, input: { cost: 5, effect: { each: 0 } } });
  });

  it('rejects a cost of 0 — that would make the item free', () => {
    expect(shopItemInput('troop_speedup', '0', '1')).toEqual({ ok: false, error: 'cost must be a positive number' });
  });

  it('rejects a negative or unparseable cost', () => {
    expect(shopItemInput('troop_speedup', '-1', '1')).toMatchObject({ ok: false });
    expect(shopItemInput('troop_speedup', 'abc', '1')).toMatchObject({ ok: false });
    expect(shopItemInput('troop_speedup', '', '1')).toMatchObject({ ok: false });
  });

  it('rejects a negative effect, quoting the field’s own label', () => {
    expect(shopItemInput('resource_pack', '5', '-2')).toEqual({ ok: false, error: 'Amount per resource must be a non-negative number' });
  });

  it('sends no effect at all for battle_pass, and ignores whatever the (absent) input held', () => {
    expect(shopItemInput('battle_pass', '990', 'nonsense')).toEqual({ ok: true, input: { cost: 990 } });
  });

  it('checks the cost before the effect — a broken cost is the more fundamental error', () => {
    expect(shopItemInput('resource_pack', '0', '-5')).toMatchObject({ error: 'cost must be a positive number' });
  });
});

describe('shopMetaText', () => {
  it('attributes an override and stamps it through the formatter it was given', () => {
    expect(shopMetaText(row({ doc: overrideDoc('Ada') }), stamp)).toBe('Overridden by Ada · T99');
  });

  it('falls back to an em dash for a nameless writer', () => {
    expect(shopMetaText(row({ doc: overrideDoc('') }), stamp)).toBe('Overridden by — · T99');
  });

  it('reports the code default when nothing is overridden', () => {
    expect(shopMetaText(row(), stamp)).toBe('Not overridden, using default (cost 10)');
  });
});
