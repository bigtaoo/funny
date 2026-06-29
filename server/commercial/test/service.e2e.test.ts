// commercial service 端到端（S5-2~4）：真实 Mongo 专属库。Mongo 不可达整套 skip。
//   钱包默认/加币/扣币守卫、shop/gacha orderId 幂等、并发不超扣、recharge receiptId 幂等、ads 加币。
// 需 `cd server && docker compose up -d`。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCommercialMongo, type CommercialMongo } from '../src/db';
import { CommercialService } from '../src/service';
import type { RandInt } from '../src/gacha';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_commercial_test';

async function tryConnect(): Promise<CommercialMongo | null> {
  try {
    return await createCommercialMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[commercial.e2e] Mongo 不可达（${URI}）— 跳过。先跑 docker compose up -d。`);
}

const zero: RandInt = () => 0;
let t = 1000;
const now = () => t++;

describe.skipIf(!mongo)('commercial service e2e', () => {
  const m = mongo!;
  let svc: CommercialService;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    svc = new CommercialService({ cols: m.collections, now, rng: zero });
  });

  afterAll(async () => {
    if (m) {
      await m.db.dropDatabase();
      await m.close();
    }
  });

  it('钱包默认 0 / pity 空', async () => {
    expect(await svc.getWallet('a')).toEqual({ coins: 0, pity: {} });
  });

  it('充值加币 + receiptId 幂等', async () => {
    const r1 = await svc.rechargeVerify({ accountId: 'a', platform: 'web', receipt: 'tier:mid', receiptId: 'rc1' });
    expect(r1).toMatchObject({ ok: true, coinsGranted: 3300, coinsAfter: 3300 });
    // 同 receiptId 重放：不重复发币，返回原结果。
    const r2 = await svc.rechargeVerify({ accountId: 'a', platform: 'web', receipt: 'tier:mid', receiptId: 'rc1' });
    expect(r2).toMatchObject({ ok: true, coinsGranted: 3300, coinsAfter: 3300 });
    expect((await svc.getWallet('a')).coins).toBe(3300);
  });

  it('同 receiptId 被他账号占用 → 拒绝（防跨账号余额泄露）', async () => {
    // a 先用 rcShared 充值（余额 3300）。
    const r1 = await svc.rechargeVerify({ accountId: 'a', platform: 'web', receipt: 'tier:mid', receiptId: 'rcShared' });
    expect(r1).toMatchObject({ ok: true, coinsGranted: 3300, coinsAfter: 3300 });
    // b 复用同一 receiptId：必须拒绝，绝不回放 a 的余额。
    const r2 = await svc.rechargeVerify({ accountId: 'b', platform: 'web', receipt: 'tier:mid', receiptId: 'rcShared' });
    expect(r2).toEqual({ ok: false, error: 'INVALID_RECEIPT' });
    // b 钱包不受影响。
    expect((await svc.getWallet('b')).coins).toBe(0);
    // a 同 receiptId 重放仍正常（返回本账号余额）。
    const r3 = await svc.rechargeVerify({ accountId: 'a', platform: 'web', receipt: 'tier:mid', receiptId: 'rcShared' });
    expect(r3).toMatchObject({ ok: true, coinsGranted: 3300, coinsAfter: 3300 });
  });

  it('余额不足拒绝扣币', async () => {
    const r = await svc.shopCharge({ accountId: 'b', itemId: 'skin_shop_c1', cost: 300, orderId: 'o1' });
    expect(r).toEqual({ ok: false, error: 'INSUFFICIENT_FUNDS' });
  });

  it('商店扣币 + orderId 幂等重放', async () => {
    await svc.rechargeVerify({ accountId: 'c', platform: 'web', receipt: 'tier:small', receiptId: 'rcc' }); // 600
    const r1 = await svc.shopCharge({ accountId: 'c', itemId: 'skin_shop_c1', cost: 300, orderId: 'o2' });
    expect(r1).toMatchObject({ ok: true, coinsAfter: 300, status: 'charged' });
    // 重放同 orderId：不重复扣币，返回原结果。
    const r2 = await svc.shopCharge({ accountId: 'c', itemId: 'skin_shop_c1', cost: 300, orderId: 'o2' });
    expect(r2).toMatchObject({ ok: true, coinsAfter: 300 });
    expect((await svc.getWallet('c')).coins).toBe(300);
  });

  it('盲盒：单抽扣 150、pity+1、orderId 幂等', async () => {
    await svc.rechargeVerify({ accountId: 'e', platform: 'web', receipt: 'tier:small', receiptId: 'rce' }); // 600
    const r1 = await svc.gachaDraw({ accountId: 'e', poolId: 'standard', count: 1, orderId: 'g1' });
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.coinsAfter).toBe(450);
      expect(r1.results).toHaveLength(1);
      expect(r1.pityAfter).toBe(1);
    }
    const hist = await m.collections.gachaHistory.find({ accountId: 'e' }).toArray();
    expect(hist).toHaveLength(1);
    // 重放幂等
    const r2 = await svc.gachaDraw({ accountId: 'e', poolId: 'standard', count: 1, orderId: 'g1' });
    expect(r2.ok && r2.coinsAfter).toBe(450);
    expect((await svc.getWallet('e')).coins).toBe(450);
    expect((await svc.getWallet('e')).pity.standard).toBe(1);
  });

  it('并发扣币不超支（10 个并发单抽，余额仅够 3 抽）', async () => {
    await svc.rechargeVerify({ accountId: 'f', platform: 'web', receipt: 'tier:small', receiptId: 'rcf2' }); // 600
    // 余额 600 / 单抽 150 → 最多 4 抽。发 10 个不同 orderId 并发。
    const calls = Array.from({ length: 10 }, (_, i) =>
      svc.gachaDraw({ accountId: 'f', poolId: 'standard', count: 1, orderId: `c${i}` }),
    );
    const res = await Promise.all(calls);
    const okCount = res.filter((r) => r.ok).length;
    expect(okCount).toBe(4);
    expect((await svc.getWallet('f')).coins).toBe(0);
  });

  it('订单发货闭环：delivered 标记 + refundCoins 入账幂等', async () => {
    await svc.rechargeVerify({ accountId: 'g', platform: 'web', receipt: 'tier:small', receiptId: 'rcg' }); // 600
    await svc.shopCharge({ accountId: 'g', itemId: 'skin_shop_c1', cost: 300, orderId: 'od1' }); // 余 300
    const d1 = await svc.orderDelivered({ orderId: 'od1', refundCoins: 50 });
    expect(d1.ok).toBe(true);
    expect((await svc.getWallet('g')).coins).toBe(350); // 退 50
    // 重放 delivered：不重复退币。
    await svc.orderDelivered({ orderId: 'od1', refundCoins: 50 });
    expect((await svc.getWallet('g')).coins).toBe(350);
    // 对账：已发货订单不再出现在未发货列表。
    expect(await svc.undeliveredOrders('g')).toHaveLength(0);
  });

  it('未验单不发币（空 receipt → INVALID_RECEIPT）', async () => {
    const r = await svc.rechargeVerify({ accountId: 'h', platform: 'web', receipt: '', receiptId: 'rch' });
    expect(r).toEqual({ ok: false, error: 'INVALID_RECEIPT' });
  });

  it('广告加币', async () => {
    const r = await svc.adsCredit({ accountId: 'i', amount: 50, dayKey: '2026-06-14' });
    expect(r).toMatchObject({ ok: true, coinsAfter: 50 });
  });

  it('胜利金币：每日上限内发币、超限 capped 不发、跨日重置', async () => {
    // 当日 10 局封顶（VICTORY_DAILY_WIN_CAP），每局 5 币 → 共 50。
    let last = 0;
    for (let i = 0; i < 10; i++) {
      const r = await svc.victoryCredit({ accountId: 'v', amount: 5, dayKey: '2026-06-14' });
      expect(r).toMatchObject({ ok: true, credited: 5, capped: false });
      if (r.ok) last = r.coinsAfter;
    }
    expect(last).toBe(50);
    // 第 11 局：超限不发币。
    const over = await svc.victoryCredit({ accountId: 'v', amount: 5, dayKey: '2026-06-14' });
    expect(over).toMatchObject({ ok: true, credited: 0, capped: true });
    expect((await svc.getWallet('v')).coins).toBe(50);
    // 跨日重置：新 dayKey 又可领。
    const nextDay = await svc.victoryCredit({ accountId: 'v', amount: 5, dayKey: '2026-06-15' });
    expect(nextDay).toMatchObject({ ok: true, credited: 5, capped: false });
    expect((await svc.getWallet('v')).coins).toBe(55);
  });

  it('spend（改名 sink）：扣币 + orderId 幂等 + 余额不足拒绝 + 对账不拾取', async () => {
    await svc.rechargeVerify({ accountId: 'j', platform: 'web', receipt: 'tier:small', receiptId: 'rcj' }); // 600
    const r1 = await svc.spend({ accountId: 'j', amount: 500, reason: 'rename', orderId: 'sp1' });
    expect(r1).toMatchObject({ ok: true, coinsAfter: 100 });
    // orderId 幂等：重放不再扣。
    const r2 = await svc.spend({ accountId: 'j', amount: 500, reason: 'rename', orderId: 'sp1' });
    expect(r2).toMatchObject({ ok: true, coinsAfter: 100 });
    expect((await svc.getWallet('j')).coins).toBe(100);
    // 余额不足拒绝。
    const r3 = await svc.spend({ accountId: 'j', amount: 500, reason: 'rename', orderId: 'sp2' });
    expect(r3).toEqual({ ok: false, error: 'INSUFFICIENT_FUNDS' });
    // sink 落库即 delivered → 对账不拾取。
    expect(await svc.undeliveredOrders('j')).toHaveLength(0);
  });

  it('grant（邮件附件发币）：加币 + orderId 幂等 + amount=0 仅占订单 + 对账不拾取', async () => {
    const r1 = await svc.grant({ accountId: 'g', amount: 500, reason: 'mail', orderId: 'gr1' });
    expect(r1).toMatchObject({ ok: true, coinsAfter: 500 });
    // orderId 幂等：重放不再加。
    const r2 = await svc.grant({ accountId: 'g', amount: 500, reason: 'mail', orderId: 'gr1' });
    expect(r2).toMatchObject({ ok: true, coinsAfter: 500 });
    expect((await svc.getWallet('g')).coins).toBe(500);
    // amount=0（纯物品/皮肤附件）仅占幂等订单，不加币。
    const r3 = await svc.grant({ accountId: 'g', amount: 0, reason: 'mail', orderId: 'gr2' });
    expect(r3).toMatchObject({ ok: true, coinsAfter: 500 });
    // grant 落库即 delivered → 对账不拾取。
    expect(await svc.undeliveredOrders('g')).toHaveLength(0);
  });
});
