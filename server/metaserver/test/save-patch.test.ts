// applySyncPatch 信任边界单测（M5 / SERVER_API.md §2.2）—— always-run，不需 Mongo。
//
// 防客户端篡改的安全防线：PUT /save 只接同步段，钱包/库存/盲盒/天梯是服务器权威。
// e2e（save.e2e.test.ts）也验「硬墙」，但仅 Mongo 在跑时；此函数是纯逻辑，
// 该无条件覆盖——否则无 DB 的 CI 下这条安全断言静默缺席。
//
// 导入 dist（metaserver 是 NodeNext/ESM，.js 扩展名）；跑前 tsc -b（test 脚本已含）。
import { describe, expect, it } from 'vitest';
import { makeNewSave } from '@nw/shared';
import { applySyncPatch } from '../dist/save.js';

const NOW = 1_700_000_000_000;

describe('applySyncPatch 信任边界', () => {
  it('只覆盖同步段，权威段（wallet/inventory/gacha/pvp）原样保留', () => {
    const prev = makeNewSave('acc', 0);
    prev.wallet.coins = 500;
    prev.inventory.skins = ['skin_a'];
    prev.pvp.elo = 1234;
    prev.gacha.pity = { pool1: 7 };

    const next = applySyncPatch(prev, { flags: { seen_intro: true } }, NOW, 1);

    expect(next.wallet.coins).toBe(500);
    expect(next.inventory.skins).toEqual(['skin_a']);
    expect(next.pvp.elo).toBe(1234);
    expect(next.gacha.pity).toEqual({ pool1: 7 });
    expect(next.flags).toEqual({ seen_intro: true });
  });

  it('硬墙：patch 塞入权威段被结构性丢弃（HTTP body 无类型，客户端篡改无效）', () => {
    const prev = makeNewSave('acc', 0);
    // 模拟恶意/越界 body：SyncPatch 类型不含这些字段，运行期也必须丢弃。
    // PVE_INTEGRITY_PLAN §8 起 progress/materials/pveUpgrades 也是服务器权威 → 同样丢弃。
    const malicious = {
      flags: { x: true },
      wallet: { coins: 999_999 },
      inventory: { skins: ['hacked'], items: { gold: 999 } },
      pvp: { elo: 9999, rank: 'legend', wins: 999, losses: 0, streak: 99 },
      gacha: { pity: { p: 999 } },
      progress: { cleared: ['ch_stress'], stars: { ch_stress: 3 }, best: {} },
      materials: { scrap: 999 },
      pveUpgrades: { inf_hp: 5 },
    } as Parameters<typeof applySyncPatch>[1];

    const next = applySyncPatch(prev, malicious, NOW, 1);

    expect(next.wallet.coins).toBe(0); // 未被 999999 覆盖
    expect(next.inventory.skins).toEqual([]); // 未被 'hacked' 覆盖
    expect(next.pvp.elo).toBe(1000); // 默认值，未被 9999 覆盖
    expect(next.gacha.pity).toEqual({}); // 未被覆盖
    expect(next.progress.cleared).toEqual([]); // §8 服务器权威，未被覆盖
    expect(next.materials).toEqual({}); // §8 服务器权威，未被覆盖
    expect(next.pveUpgrades).toEqual({}); // §8 服务器权威，未被覆盖
    expect(next.flags).toEqual({ x: true }); // 合法同步段照常写入
  });

  it('rev / updatedAt 按入参设定，其余不变', () => {
    const prev = makeNewSave('acc', 0);
    const next = applySyncPatch(prev, {}, NOW, 5);
    expect(next.rev).toBe(5);
    expect(next.updatedAt).toBe(NOW);
    expect(next.accountId).toBe('acc');
    expect(next.version).toBe(prev.version);
  });

  it('空 patch：所有段保持 prev（仅 rev/updatedAt 推进）', () => {
    const prev = makeNewSave('acc', 0);
    prev.progress.cleared = ['ch1_lv1'];
    prev.materials = { wood: 3 };
    prev.equipped = { skin: 's1' };
    const next = applySyncPatch(prev, {}, NOW, 1);
    expect(next.progress.cleared).toEqual(['ch1_lv1']);
    expect(next.materials).toEqual({ wood: 3 });
    expect(next.equipped).toEqual({ skin: 's1' });
  });

  it('部分 patch：提供的同步段（equipped/flags）覆盖，未提供的保留 prev', () => {
    const prev = makeNewSave('acc', 0);
    prev.equipped = { skin: 's1' };
    prev.flags = { seen_intro: true };

    const next = applySyncPatch(prev, { equipped: { skin: 's2' } }, NOW, 1);

    expect(next.equipped).toEqual({ skin: 's2' }); // 覆盖
    expect(next.flags).toEqual({ seen_intro: true }); // 未提供 → 保留
  });

  it('不改动入参 prev（无副作用）', () => {
    const prev = makeNewSave('acc', 0);
    applySyncPatch(prev, { flags: { a: true } }, NOW, 1);
    expect(prev.flags).toEqual({}); // prev 未被污染
    expect(prev.rev).toBe(0);
  });
});
