// 装备 → 蓝图注入单测（EQUIPMENT_DESIGN §9 E1）。守三件事：
//   ① 天梯红线（L1）：满装备下 buildPvpBlueprints() 仍与 UNIT_BLUEPRINTS 逐字相等；
//   ② 战力单调性：装备↑ → campaign/siege 蓝图战力↑（主词条随强化放大，副词条固定）；
//   ③ 跨系统封顶（§7.7）：乘算装备贡献 + 绝对字段全来源求和都钳到 EFFECT_CAPS。
import { describe, it, expect } from 'vitest';
import { UNIT_BLUEPRINTS } from '../src/game/config';
import { UnitType } from '../src/game/types';
import {
  buildPvpBlueprints,
  buildCampaignBlueprints,
  buildSiegeBlueprints,
} from '../src/game/balance/pveUpgrades';
import {
  applyEquipment,
  clampEffectCaps,
  EFFECT_CAPS,
  ENHANCE_COEFF_PER_LEVEL,
  type EngineEquipmentInput,
  type EngineAffix,
} from '../src/game/balance/equipment';

/** 单件全局装备：把一件带 affixes 的实例穿到 weapon 槽（全军生效）。 */
function equipOne(affixes: EngineAffix[], level = 0): EngineEquipmentInput {
  return {
    gear: { global: { weapon: 'i1' } },
    inv: { i1: { defId: 'wp_pencil', level, affixes } },
  };
}

describe('装备硬墙 — PvP 蓝图永不见装备', () => {
  it('满装备在内存里，buildPvpBlueprints() 仍逐字等于 UNIT_BLUEPRINTS', () => {
    // 构造一套极端装备，但 PvP builder 签名里根本没有装备参 → 编译期不可能读到。
    void equipOne([{ id: 'm_atk', value: 999 }], 9);
    expect(buildPvpBlueprints()).toEqual(UNIT_BLUEPRINTS);
  });

  it('campaign 注入装备后，再 build 的 PvP 蓝图仍与常量逐字相等（不串味、不污染常量）', () => {
    const before = JSON.parse(JSON.stringify(UNIT_BLUEPRINTS));
    buildCampaignBlueprints({}, equipOne([{ id: 'm_atk', value: 50 }], 9));
    expect(UNIT_BLUEPRINTS).toEqual(before);
    expect(buildPvpBlueprints()).toEqual(before);
  });

  it('无装备时 campaign/siege 蓝图 = 仅 upgrades 蓝图（注入链对空装备为 no-op）', () => {
    expect(buildCampaignBlueprints({})).toEqual(buildCampaignBlueprints({}, undefined));
    expect(buildSiegeBlueprints({ inf_hp: 3 })).toEqual(buildSiegeBlueprints({ inf_hp: 3 }, undefined));
  });
});

describe('装备战力单调性（§8）', () => {
  it('穿一件攻击主词条 → 玩家兵种攻击 > 基础', () => {
    const camp = buildCampaignBlueprints({}, equipOne([{ id: 'm_atk', value: 20 }]));
    expect(camp[UnitType.Infantry].attack).toBeGreaterThan(UNIT_BLUEPRINTS[UnitType.Infantry].attack);
    expect(camp[UnitType.Archer].attack).toBeGreaterThan(UNIT_BLUEPRINTS[UnitType.Archer].attack);
  });

  it('campaign 与 siege 共用注入链 → 同装备同结果', () => {
    const equip = equipOne([{ id: 'm_hp', value: 30 }], 2);
    expect(buildSiegeBlueprints({}, equip)).toEqual(buildCampaignBlueprints({}, equip));
  });

  it('主词条随强化等级放大：+5 攻击 > +0 攻击', () => {
    const lv0 = buildCampaignBlueprints({}, equipOne([{ id: 'm_atk', value: 20 }], 0));
    const lv5 = buildCampaignBlueprints({}, equipOne([{ id: 'm_atk', value: 20 }], 5));
    expect(lv5[UnitType.Infantry].attack).toBeGreaterThan(lv0[UnitType.Infantry].attack);
  });

  it('主词条放大遵循 base × (1 + value/100 × (1 + 系数×level))', () => {
    const value = 20;
    const level = 5;
    const camp = buildCampaignBlueprints({}, equipOne([{ id: 'm_atk', value }], level));
    const effPct = (value / 100) * (1 + ENHANCE_COEFF_PER_LEVEL * level);
    const expected = Math.round(UNIT_BLUEPRINTS[UnitType.Infantry].attack * (1 + effPct));
    expect(camp[UnitType.Infantry].attack).toBe(expected);
  });

  it('副词条固定、不随强化等级变', () => {
    const lv0 = buildCampaignBlueprints({}, equipOne([{ id: 's_atk', value: 20 }], 0));
    const lv9 = buildCampaignBlueprints({}, equipOne([{ id: 's_atk', value: 20 }], 9));
    expect(lv9[UnitType.Infantry].attack).toBe(lv0[UnitType.Infantry].attack);
  });

  it('攻速主词条降低攻击间隔（§7.4 乘算降间隔）', () => {
    const camp = buildCampaignBlueprints({}, equipOne([{ id: 'm_atkspd', value: 20 }]));
    expect(camp[UnitType.Infantry].attackInterval).toBeLessThan(
      UNIT_BLUEPRINTS[UnitType.Infantry].attackInterval,
    );
  });
});

describe('跨系统封顶（§7.7）', () => {
  it('攻击% 装备贡献钳到 EFFECT_CAPS.atkPct（天价词条不破值）', () => {
    const camp = buildCampaignBlueprints({}, equipOne([{ id: 'm_atk', value: 100000 }], 9));
    const capped = Math.round(UNIT_BLUEPRINTS[UnitType.Infantry].attack * (1 + EFFECT_CAPS.atkPct));
    expect(camp[UnitType.Infantry].attack).toBe(capped);
  });

  it('吸血全来源求和钳到 EFFECT_CAPS.lifestealPct（clampEffectCaps 跨源统一钳）', () => {
    const camp = buildCampaignBlueprints({}, equipOne([{ id: 's_lifesteal', value: 999 }]));
    expect(camp[UnitType.Infantry].lifestealPct).toBe(EFFECT_CAPS.lifestealPct);
  });

  it('clampEffectCaps 直接钳：base 自带 + 超额吸血 → 钳到上限', () => {
    const bp = buildPvpBlueprints();
    bp[UnitType.Infantry].lifestealPct = 80; // 模拟 trait + 装备求和后的超额值
    clampEffectCaps(bp);
    expect(bp[UnitType.Infantry].lifestealPct).toBe(EFFECT_CAPS.lifestealPct);
  });
});

describe('作用范围与容错', () => {
  it('只加成玩家兵种，PvE 专属怪种不受影响', () => {
    const camp = buildCampaignBlueprints({}, equipOne([{ id: 'm_atk', value: 50 }], 9));
    expect(camp[UnitType.Ironclad]).toEqual(UNIT_BLUEPRINTS[UnitType.Ironclad]);
    expect(camp[UnitType.Runner]).toEqual(UNIT_BLUEPRINTS[UnitType.Runner]);
  });

  it('未知词条 id / 引用缺失实例 / 空 loadout 全部安全 no-op', () => {
    expect(buildCampaignBlueprints({}, equipOne([{ id: 'not_a_real_affix', value: 50 }]))).toEqual(
      buildCampaignBlueprints({}),
    );
    const missing: EngineEquipmentInput = { gear: { global: { weapon: 'ghost' } }, inv: {} };
    expect(buildCampaignBlueprints({}, missing)).toEqual(buildCampaignBlueprints({}));
    const empty: EngineEquipmentInput = { gear: {}, inv: {} };
    expect(buildCampaignBlueprints({}, empty)).toEqual(buildCampaignBlueprints({}));
  });

  it('功能类副词条（材料掉落/体力）不进战斗蓝图', () => {
    expect(buildCampaignBlueprints({}, equipOne([{ id: 's_matdrop', value: 50 }]))).toEqual(
      buildCampaignBlueprints({}),
    );
  });

  it('applyEquipment 不污染全局常量', () => {
    const before = JSON.parse(JSON.stringify(UNIT_BLUEPRINTS));
    const bp = buildPvpBlueprints();
    applyEquipment(bp, equipOne([{ id: 'm_atk', value: 50 }], 9));
    expect(UNIT_BLUEPRINTS).toEqual(before);
  });

  it('byUnit 优先于 global（阶段二按兵种覆盖）', () => {
    const equip: EngineEquipmentInput = {
      gear: { global: { weapon: 'g' }, byUnit: { [UnitType.Archer]: { weapon: 'a' } } },
      inv: {
        g: { defId: 'wp_pencil', level: 0, affixes: [{ id: 'm_atk', value: 10 }] },
        a: { defId: 'wp_marker', level: 0, affixes: [{ id: 'm_atk', value: 50 }] },
      },
    };
    const camp = buildCampaignBlueprints({}, equip);
    // Archer 用 byUnit（+50%），Infantry 用 global（+10%）。
    const arc = Math.round(UNIT_BLUEPRINTS[UnitType.Archer].attack * 1.5);
    const inf = Math.round(UNIT_BLUEPRINTS[UnitType.Infantry].attack * 1.1);
    expect(camp[UnitType.Archer].attack).toBe(arc);
    expect(camp[UnitType.Infantry].attack).toBe(inf);
  });
});
