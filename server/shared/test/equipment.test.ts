// Unit tests for equipment.ts: catalogue integrity, enhancement odds/costs, deterministic craft/drop/reforge
// rolls, salvage refunds (EQUIPMENT_DESIGN §3/§6/§7). Pure functions, no DB.
import { describe, it, expect } from 'vitest';
import {
  EQUIP_SLOTS,
  RARITY_AFFIX_SLOTS,
  EQUIPMENT_DEFS,
  getEquipDef,
  EQUIP_MAX_LEVEL,
  SALVAGE_REFUND_RATIO,
  enhanceSuccessRate,
  enhanceCost,
  rollEnhanceSuccess,
  salvageRefund,
  MAIN_AFFIX_BY_SLOT,
  SUB_AFFIX_POOL,
  CRAFT_SUB_AFFIX_COUNT,
  rollCraftedAffixes,
  makeGachaEquipInstance,
  makeDropInstance,
  rollReforgedAffixes,
  REFORGE_MATERIAL_RARITY,
  EQUIP_AUCTION_REF_PRICE_BY_RARITY,
  type EquipRarity,
} from '../src/equipment';

const RARITIES: EquipRarity[] = ['common', 'fine', 'rare', 'epic'];

// ── catalogue integrity ───────────────────────────────────────────────────────────

describe('EQUIPMENT_DEFS', () => {
  it('has 12 items (3 slots × 4 rarities)', () => {
    expect(Object.keys(EQUIPMENT_DEFS)).toHaveLength(12);
  });

  it('every slot×rarity combination is covered exactly once', () => {
    for (const slot of EQUIP_SLOTS) {
      for (const rarity of RARITIES) {
        const matches = Object.values(EQUIPMENT_DEFS).filter((d) => d.slot === slot && d.rarity === rarity);
        expect(matches).toHaveLength(1);
      }
    }
  });

  it('defId matches its map key', () => {
    for (const [key, def] of Object.entries(EQUIPMENT_DEFS)) expect(def.defId).toBe(key);
  });

  it('craftable items reference only known materials', () => {
    const known = new Set(['scrap', 'lead', 'binding']);
    for (const def of Object.values(EQUIPMENT_DEFS)) {
      if (!def.craftCost) continue;
      for (const mat of Object.keys(def.craftCost)) expect(known.has(mat)).toBe(true);
    }
  });

  it('epic items are not craftable (gacha/drop only)', () => {
    for (const def of Object.values(EQUIPMENT_DEFS)) {
      if (def.rarity === 'epic') expect(def.craftCost).toBeUndefined();
    }
  });

  it('getEquipDef resolves known and misses unknown', () => {
    expect(getEquipDef('wp_pencil')?.slot).toBe('weapon');
    expect(getEquipDef('nope')).toBeUndefined();
  });
});

describe('RARITY_AFFIX_SLOTS', () => {
  it('sub-affix count is non-decreasing with rarity', () => {
    for (let i = 1; i < RARITIES.length; i++) {
      expect(RARITY_AFFIX_SLOTS[RARITIES[i]!].sub).toBeGreaterThanOrEqual(RARITY_AFFIX_SLOTS[RARITIES[i - 1]!].sub);
    }
  });

  it('only epic has a skill slot', () => {
    expect(RARITY_AFFIX_SLOTS.epic.skill).toBe(1);
    expect(RARITY_AFFIX_SLOTS.common.skill).toBe(0);
    expect(RARITY_AFFIX_SLOTS.fine.skill).toBe(0);
    expect(RARITY_AFFIX_SLOTS.rare.skill).toBe(0);
  });

  it('CRAFT_SUB_AFFIX_COUNT matches the sub-slot budget', () => {
    for (const r of RARITIES) expect(CRAFT_SUB_AFFIX_COUNT[r]).toBe(RARITY_AFFIX_SLOTS[r].sub);
  });
});

// ── enhancement odds ──────────────────────────────────────────────────────────────

describe('enhanceSuccessRate', () => {
  it('0→1 is 90%, 8→9 is 10%', () => {
    expect(enhanceSuccessRate(0)).toBeCloseTo(0.9, 10);
    expect(enhanceSuccessRate(8)).toBeCloseTo(0.1, 10);
  });

  it('decreases by 10 points each level', () => {
    for (let lv = 0; lv < EQUIP_MAX_LEVEL - 1; lv++) {
      expect(enhanceSuccessRate(lv) - enhanceSuccessRate(lv + 1)).toBeCloseTo(0.1, 10);
    }
  });

  it('is 0 at or beyond max level, and for negatives', () => {
    expect(enhanceSuccessRate(EQUIP_MAX_LEVEL)).toBe(0);
    expect(enhanceSuccessRate(EQUIP_MAX_LEVEL + 5)).toBe(0);
    expect(enhanceSuccessRate(-1)).toBe(0);
  });
});

describe('enhanceCost', () => {
  it('coins increase with level', () => {
    for (let lv = 0; lv < EQUIP_MAX_LEVEL - 1; lv++) {
      expect(enhanceCost(lv + 1).coins).toBeGreaterThan(enhanceCost(lv).coins);
    }
  });

  it('scrap requirement grows with level', () => {
    expect(enhanceCost(0).materials.scrap).toBe(4);
    expect(enhanceCost(1).materials.scrap).toBe(6);
  });

  it('lead is only required from +3', () => {
    expect(enhanceCost(2).materials.lead).toBeUndefined();
    expect(enhanceCost(3).materials.lead).toBe(1);
  });

  it('binding is only required from +6', () => {
    expect(enhanceCost(5).materials.binding).toBeUndefined();
    expect(enhanceCost(6).materials.binding).toBe(1);
  });

  it('clamps out-of-range levels into the valid band', () => {
    expect(enhanceCost(-5)).toEqual(enhanceCost(0));
    expect(enhanceCost(999)).toEqual(enhanceCost(EQUIP_MAX_LEVEL - 1));
  });
});

describe('rollEnhanceSuccess', () => {
  it('is deterministic for the same key+level', () => {
    const a = rollEnhanceSuccess('key-abc', 3);
    const b = rollEnhanceSuccess('key-abc', 3);
    expect(a).toBe(b);
  });

  it('empirical success frequency tracks the configured rate at +0 (~90%)', () => {
    let hits = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) if (rollEnhanceSuccess(`k${i}`, 0)) hits++;
    expect(hits / N).toBeGreaterThan(0.82);
    expect(hits / N).toBeLessThan(0.97);
  });

  it('high level (+8, 10%) succeeds far less often than +0', () => {
    let hi = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) if (rollEnhanceSuccess(`k${i}`, 8)) hi++;
    expect(hi / N).toBeLessThan(0.2);
  });
});

// ── salvage ───────────────────────────────────────────────────────────────────────

describe('salvageRefund', () => {
  it('returns a floored fraction of the craft cost', () => {
    // wp_pencil craftCost scrap:5 → floor(5*0.7)=3
    expect(salvageRefund('wp_pencil')).toEqual({ scrap: 3 });
  });

  it('never refunds more than the crafting cost', () => {
    for (const [defId, def] of Object.entries(EQUIPMENT_DEFS)) {
      if (!def.craftCost) continue;
      const refund = salvageRefund(defId);
      for (const [mat, qty] of Object.entries(refund)) {
        expect(qty).toBeLessThanOrEqual(def.craftCost[mat]! * SALVAGE_REFUND_RATIO + 1e-9);
      }
    }
  });

  it('non-craftable (epic) items refund nothing', () => {
    expect(salvageRefund('wp_highlighter')).toEqual({});
  });

  it('unknown defId refunds nothing', () => {
    expect(salvageRefund('nope')).toEqual({});
  });
});

// ── craft roll ────────────────────────────────────────────────────────────────────

describe('rollCraftedAffixes', () => {
  it('throws on unknown defId', () => {
    expect(() => rollCraftedAffixes('nope', 'seed')).toThrow();
  });

  it('is deterministic for the same defId+seed', () => {
    expect(rollCraftedAffixes('wp_marker', 'seed1')).toEqual(rollCraftedAffixes('wp_marker', 'seed1'));
  });

  it('always yields exactly one main affix plus the rarity sub-count', () => {
    for (const [defId, def] of Object.entries(EQUIPMENT_DEFS)) {
      const affixes = rollCraftedAffixes(defId, 'seedX');
      const mains = affixes.filter((a) => a.id.startsWith('m_'));
      const subs = affixes.filter((a) => a.id.startsWith('s_'));
      expect(mains).toHaveLength(1);
      expect(subs).toHaveLength(CRAFT_SUB_AFFIX_COUNT[def.rarity]);
    }
  });

  it('main affix is a valid candidate for the slot', () => {
    const affixes = rollCraftedAffixes('tk_seal', 'seedY'); // trinket has 2 candidates
    const main = affixes.find((a) => a.id.startsWith('m_'))!;
    const validIds = MAIN_AFFIX_BY_SLOT.trinket.map((c) => c.id);
    expect(validIds).toContain(main.id);
  });

  it('sub-affixes are unique (no duplicate ids)', () => {
    const affixes = rollCraftedAffixes('ar_leather', 'seedZ'); // rare → 2 subs
    const subIds = affixes.filter((a) => a.id.startsWith('s_')).map((a) => a.id);
    expect(new Set(subIds).size).toBe(subIds.length);
  });

  it('sub-affix values fall within the pool ranges', () => {
    const ranges = new Map(SUB_AFFIX_POOL.map(([id, lo, hi]) => [id, [lo, hi] as const]));
    for (let i = 0; i < 50; i++) {
      const affixes = rollCraftedAffixes('tk_sticker', `s${i}`);
      for (const a of affixes.filter((x) => x.id.startsWith('s_'))) {
        const [lo, hi] = ranges.get(a.id)!;
        expect(a.value).toBeGreaterThanOrEqual(lo);
        expect(a.value).toBeLessThanOrEqual(hi);
      }
    }
  });
});

// ── gacha / drop instances ────────────────────────────────────────────────────────

describe('makeGachaEquipInstance', () => {
  it('builds a +0 instance with the def rarity and rolled affixes', () => {
    const inst = makeGachaEquipInstance('wp_highlighter', 'inst-1');
    expect(inst.id).toBe('inst-1');
    expect(inst.defId).toBe('wp_highlighter');
    expect(inst.rarity).toBe('epic');
    expect(inst.level).toBe(0);
    expect(inst.affixes.length).toBeGreaterThan(0);
  });

  it('throws on unknown defId', () => {
    expect(() => makeGachaEquipInstance('nope', 'x')).toThrow();
  });
});

describe('makeDropInstance', () => {
  it('produces an item whose def matches the requested rarity', () => {
    for (const rarity of RARITIES) {
      const inst = makeDropInstance(rarity, `drop-${rarity}`);
      expect(inst.rarity).toBe(rarity);
      expect(EQUIPMENT_DEFS[inst.defId]!.rarity).toBe(rarity);
    }
  });

  it('is deterministic for the same instance id', () => {
    expect(makeDropInstance('rare', 'seed-drop')).toEqual(makeDropInstance('rare', 'seed-drop'));
  });

  it('picks slots across the full set given varied seeds', () => {
    const slots = new Set<string>();
    for (let i = 0; i < 60; i++) slots.add(EQUIPMENT_DEFS[makeDropInstance('common', `d${i}`).defId]!.slot);
    expect(slots.size).toBeGreaterThan(1); // not stuck on a single slot
  });
});

// ── reforge ───────────────────────────────────────────────────────────────────────

describe('rollReforgedAffixes', () => {
  it('keeps the existing main affix verbatim', () => {
    const current = [{ id: 'm_crit', value: 6 }, { id: 's_atk', value: 4 }];
    const reforged = rollReforgedAffixes('tk_sticker', 'rk', current);
    const main = reforged.find((a) => a.id.startsWith('m_'))!;
    expect(main).toEqual({ id: 'm_crit', value: 6 }); // not flipped back to m_spd
  });

  it('falls back to the slot default main affix when none present', () => {
    const reforged = rollReforgedAffixes('tk_sticker', 'rk2', [{ id: 's_atk', value: 4 }]);
    const main = reforged.find((a) => a.id.startsWith('m_'))!;
    expect(main.id).toBe(MAIN_AFFIX_BY_SLOT.trinket[0]!.id);
  });

  it('re-rolls the correct number of sub-affixes', () => {
    const current = [{ id: 'm_hp', value: 10 }];
    const reforged = rollReforgedAffixes('ar_leather', 'rk3', current); // rare → 2 subs
    expect(reforged.filter((a) => a.id.startsWith('s_'))).toHaveLength(2);
  });

  it('is deterministic for the same inputs', () => {
    const current = [{ id: 'm_hp', value: 10 }];
    expect(rollReforgedAffixes('ar_leather', 'same', current)).toEqual(
      rollReforgedAffixes('ar_leather', 'same', current),
    );
  });

  it('throws on unknown defId', () => {
    expect(() => rollReforgedAffixes('nope', 'k', [])).toThrow();
  });
});

describe('REFORGE_MATERIAL_RARITY', () => {
  it('requires a one-tier-lower material for each reforgeable rarity', () => {
    expect(REFORGE_MATERIAL_RARITY.fine).toBe('common');
    expect(REFORGE_MATERIAL_RARITY.rare).toBe('fine');
    expect(REFORGE_MATERIAL_RARITY.epic).toBe('rare');
  });

  it('common cannot be reforged (no material entry)', () => {
    expect(REFORGE_MATERIAL_RARITY.common).toBeUndefined();
  });
});

describe('EQUIP_AUCTION_REF_PRICE_BY_RARITY', () => {
  it('reference prices rise with rarity', () => {
    for (let i = 1; i < RARITIES.length; i++) {
      expect(EQUIP_AUCTION_REF_PRICE_BY_RARITY[RARITIES[i]!]).toBeGreaterThan(
        EQUIP_AUCTION_REF_PRICE_BY_RARITY[RARITIES[i - 1]!],
      );
    }
  });
});
