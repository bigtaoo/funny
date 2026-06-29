// B-PROMO 优惠码兑换端到端测试（真实 Mongo，需 docker compose up -d）。
// 覆盖：创建/列出/大小写规范化/重复码/coins<=0/首次兑换/防重/过期/超限/不同玩家/流水。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCommercialMongo, type CommercialMongo } from '../src/db';
import { CommercialService } from '../src/service';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_commercial_promo_test';

async function tryConnect(): Promise<CommercialMongo | null> {
  try {
    return await createCommercialMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[promo.test] Mongo 不可达（${URI}）— 跳过。先跑 docker compose up -d。`);
}

let t = 1_000_000;
const now = () => t++;

describe.skipIf(!mongo)('promo code system', () => {
  const m = mongo!;
  let svc: CommercialService;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    svc = new CommercialService({ cols: m.collections, now });
    t = 1_000_000;
  });

  afterAll(async () => {
    await m.close();
  });

  // ── createPromoCode ─────────────────────────────────────────
  it('创建成功，code 规范化大写', async () => {
    const r = await svc.createPromoCode({ code: 'hello2025', coins: 100, createdBy: 'admin1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code).toBe('HELLO2025');
  });

  it('listPromoCodes 返回已创建的码', async () => {
    await svc.createPromoCode({ code: 'A', coins: 50, createdBy: 'admin1' });
    await svc.createPromoCode({ code: 'B', coins: 200, note: 'summer', createdBy: 'admin1' });
    const codes = await svc.listPromoCodes();
    expect(codes).toHaveLength(2);
    const b = codes.find((c) => c._id === 'B');
    expect(b?.note).toBe('summer');
    expect(b?.redeemed).toBe(0);
  });

  it('重复 code 返回 BAD_REQUEST', async () => {
    await svc.createPromoCode({ code: 'DUP', coins: 50, createdBy: 'admin1' });
    const r2 = await svc.createPromoCode({ code: 'dup', coins: 100, createdBy: 'admin1' });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error).toBe('BAD_REQUEST');
  });

  it('coins<=0 拒绝', async () => {
    const r = await svc.createPromoCode({ code: 'NEG', coins: 0, createdBy: 'admin1' });
    expect(r.ok).toBe(false);
  });

  // ── promoRedeem ─────────────────────────────────────────────
  it('首次兑换成功，coins 加入钱包', async () => {
    await svc.createPromoCode({ code: 'PROMO2025', coins: 200, createdBy: 'admin1' });
    const r = await svc.promoRedeem({ accountId: 'acc1', code: 'promo2025' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.coinsGranted).toBe(200);
    expect(r.coinsAfter).toBe(200);
  });

  it('兑换后 redeemed 递增', async () => {
    await svc.createPromoCode({ code: 'PROMO2025', coins: 200, createdBy: 'admin1' });
    await svc.promoRedeem({ accountId: 'acc1', code: 'PROMO2025' });
    const code = await m.collections.promoCodes.findOne({ _id: 'PROMO2025' });
    expect(code?.redeemed).toBe(1);
  });

  it('同玩家同码第二次 PROMO_ALREADY_USED', async () => {
    await svc.createPromoCode({ code: 'PROMO2025', coins: 200, createdBy: 'admin1' });
    await svc.promoRedeem({ accountId: 'acc1', code: 'PROMO2025' });
    const r2 = await svc.promoRedeem({ accountId: 'acc1', code: 'PROMO2025' });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error).toBe('PROMO_ALREADY_USED');
  });

  it('不同玩家可各自兑换同码', async () => {
    await svc.createPromoCode({ code: 'PROMO2025', coins: 200, createdBy: 'admin1' });
    const r1 = await svc.promoRedeem({ accountId: 'acc1', code: 'PROMO2025' });
    const r2 = await svc.promoRedeem({ accountId: 'acc2', code: 'PROMO2025' });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it('码不存在 PROMO_NOT_FOUND', async () => {
    const r = await svc.promoRedeem({ accountId: 'acc1', code: 'NOEXIST' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('PROMO_NOT_FOUND');
  });

  it('过期码 PROMO_EXPIRED', async () => {
    await svc.createPromoCode({ code: 'EXPIRED', coins: 100, expiresAt: t - 1000, createdBy: 'admin1' });
    const r = await svc.promoRedeem({ accountId: 'acc1', code: 'EXPIRED' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('PROMO_EXPIRED');
  });

  it('未过期码（expiresAt 未来）兑换成功', async () => {
    await svc.createPromoCode({ code: 'FUTURE', coins: 50, expiresAt: t + 99999, createdBy: 'admin1' });
    const r = await svc.promoRedeem({ accountId: 'acc1', code: 'FUTURE' });
    expect(r.ok).toBe(true);
  });

  it('totalLimit=1 第二人兑换 PROMO_EXHAUSTED', async () => {
    await svc.createPromoCode({ code: 'LIMITED', coins: 100, totalLimit: 1, createdBy: 'admin1' });
    await svc.promoRedeem({ accountId: 'acc1', code: 'LIMITED' });
    const r = await svc.promoRedeem({ accountId: 'acc2', code: 'LIMITED' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('PROMO_EXHAUSTED');
  });

  it('兑换写入 ledger reason=promo', async () => {
    await svc.createPromoCode({ code: 'PROMO2025', coins: 200, createdBy: 'admin1' });
    await svc.promoRedeem({ accountId: 'acc1', code: 'PROMO2025' });
    const entry = await m.collections.ledger.findOne({ accountId: 'acc1', reason: 'promo' });
    expect(entry).toBeTruthy();
    expect(entry?.delta).toBe(200);
  });
});
