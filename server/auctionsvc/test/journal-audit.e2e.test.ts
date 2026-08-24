// Owed-settlement read model end-to-end (U13 close-out ops visibility, 2026-08-24): what
// `listSettlementDebts` shows ops, against real Mongo.
//
// Most cases write journal rows directly. That is the honest unit here — this is a READ model over
// documents, and the states worth showing (a hand-over retried forty times, a rollback waiting on a
// step whose forward half never landed) are reached across a process boundary, not by driving the happy
// path. The two cases at the end do go through the real flows, to pin that the shapes the engine
// actually writes are the shapes this read understands: a fake row that happens to satisfy the reader
// proves nothing about the engine.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUCTION_DURATIONS_SEC,
  AUCTION_SETTLEMENT_STUCK_ATTEMPTS,
  AUCTION_TAX_RATE,
  SlgError,
  type AuctionSettlementDebtView,
} from '@nw/shared';
import { createAuctionMongo, type AuctionOrderDoc, type AuctionOrderStep, type AuctionMongo } from '../src/db';
import { AuctionService } from '../src/auctionService';
import type { AuctionCommercialClient } from '../src/commercialClient';
import type { AuctionMetaClient } from '../src/metaClient';
import type { AuctionMailClient, AuctionMailContent } from '../src/mailClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_auction_journal_audit_e2e_test';

async function tryConnect(): Promise<AuctionMongo | null> {
  try {
    return await createAuctionMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[auctionsvc.journal-audit.e2e] Mongo unreachable (${URI}) — skipping.`);
}

describe.skipIf(!mongo)('owed-settlement read model', () => {
  const DUR = AUCTION_DURATIONS_SEC[0]!;

  const mailbox = new Map<string, { account: string; content: AuctionMailContent }>();
  const mailFaults = new Map<string, number>();
  const balances = new Map<string, number>();

  const commercial: AuctionCommercialClient = {
    available: true,
    async spend(accountId, amount) {
      const balance = balances.get(accountId) ?? 0;
      if (balance < amount) throw new SlgError('INSUFFICIENT_FUNDS');
      balances.set(accountId, balance - amount);
    },
  };
  const mail: AuctionMailClient = {
    available: true,
    async sendSystemMail(accountId, dispatchKey, content) {
      for (const [fragment, remaining] of mailFaults) {
        if (remaining > 0 && dispatchKey.includes(fragment)) {
          mailFaults.set(fragment, remaining - 1);
          throw new Error(`meta 500 for ${dispatchKey}`);
        }
      }
      mailbox.set(dispatchKey, { account: accountId, content });
    },
  };
  const meta: AuctionMetaClient = {
    available: true,
    async deductMaterial() { /* material listings need no escrow bookkeeping here */ },
    async grantMaterial() { /* ditto */ },
    async escrowEquipment() { throw new SlgError('EQUIP_NOT_FOUND'); },
    async grantEquipment() { /* unused */ },
    async escrowCard() { throw new SlgError('CARD_NOT_FOUND'); },
    async grantCard() { /* unused */ },
    async escrowSkin(_a, skinId) { return skinId; },
    async grantSkin() { /* unused */ },
  };

  let svc: AuctionService;
  let nowMs = Date.now();

  beforeEach(async () => {
    for (const c of Object.values(mongo!.collections)) await c.deleteMany({});
    mailbox.clear();
    mailFaults.clear();
    balances.clear();
    nowMs = Date.now();
    svc = new AuctionService({ cols: mongo!.collections, commercial, meta, mail, now: () => nowMs });
  });

  afterAll(async () => {
    await mongo?.close();
  });

  const spendStep = (over: Partial<Extract<AuctionOrderStep, { op: 'spend' }>> = {}): AuctionOrderStep =>
    ({ name: 'spend', key: 'k-spend', op: 'spend', accountId: 'buyer', amount: 100, ...over });
  const coinStep = (over: Partial<Extract<AuctionOrderStep, { op: 'mailCoins' }>> = {}): AuctionOrderStep =>
    ({ name: 'seller', key: 'k-seller', op: 'mailCoins', accountId: 'seller', amount: 90, reason: 'proceeds', ...over });
  const itemStep = (over: Partial<Extract<AuctionOrderStep, { op: 'mailItem' }>> = {}): AuctionOrderStep =>
    ({
      name: 'item', key: 'k-item', op: 'mailItem', accountId: 'buyer', reason: 'sold',
      snapshot: { itemType: 'material', item: { material: 'scrap' }, qty: 3 },
      ...over,
    });

  /** Insert a journal row directly — the state a dead or retrying process leaves behind. */
  async function seedRow(over: Partial<AuctionOrderDoc> = {}): Promise<AuctionOrderDoc> {
    const row: AuctionOrderDoc = {
      _id: 'auction_buy:a:seller:1:1:buyer',
      auctionId: 'a:seller:1:1',
      kind: 'buy',
      actorId: 'buyer',
      status: 'pending',
      steps: [spendStep(), itemStep(), coinStep()],
      prefix: 0,
      done: {},
      started: {},
      decided: true,
      compensation: [{ name: 'unclaim', key: 'k-unclaim', op: 'unclaim', auctionId: 'a:seller:1:1', buyerId: 'buyer' }],
      cycle: 0,
      claimedAt: nowMs,
      attempts: 1,
      nextAttemptAt: nowMs,
      ts: nowMs,
      ...over,
    };
    await mongo!.collections.auctionOrders.insertOne(row);
    return row;
  }

  const ids = (debts: AuctionSettlementDebtView[]): string[] => debts.map((d) => d.orderId);

  // ── Which rows count as a debt ───────────────────────────────────────────────────────────────────

  it('lists only pending settlements — a done one handed over and an aborted one unwound cleanly', async () => {
    await seedRow({ _id: 'pending-1' });
    await seedRow({ _id: 'done-1', status: 'done' });
    await seedRow({ _id: 'aborted-1', status: 'aborted' });

    expect(ids(await svc.listSettlementDebts())).toEqual(['pending-1']);
  });

  it('reports nothing at all when every settlement has finished', async () => {
    await seedRow({ _id: 'done-1', status: 'done' });
    expect(await svc.listSettlementDebts()).toEqual([]);
  });

  // ── Filters ─────────────────────────────────────────────────────────────────────────────────────

  it('filters by auctionId', async () => {
    await seedRow({ _id: 'r-1', auctionId: 'a:s:1:1' });
    await seedRow({ _id: 'r-2', auctionId: 'a:s:2:2' });

    expect(ids(await svc.listSettlementDebts({ auctionId: 'a:s:2:2' }))).toEqual(['r-2']);
  });

  it('filters by minAttempts, and treats 0 as "no threshold" rather than "attempts must equal 0"', async () => {
    await seedRow({ _id: 'fresh', attempts: 1 });
    await seedRow({ _id: 'stuck', attempts: 30 });

    expect(ids(await svc.listSettlementDebts({ minAttempts: 10 }))).toEqual(['stuck']);
    expect(ids(await svc.listSettlementDebts({ minAttempts: 0 })).sort()).toEqual(['fresh', 'stuck']);
    expect(ids(await svc.listSettlementDebts()).sort()).toEqual(['fresh', 'stuck']);
  });

  it('matches an account that is only OWED something, not just the actor', async () => {
    // The case that makes an actorId-only filter useless in practice: an outbid bidder waiting on their
    // refund is not the actor of the bid flow that owes it, so looking them up by account would answer
    // "no debts" to the exact question ops is asking.
    await seedRow({
      _id: 'bid-flow',
      kind: 'bid',
      actorId: 'newBidder',
      steps: [spendStep({ accountId: 'newBidder' }), coinStep({ name: 'refundPrev', accountId: 'outbidBidder', amount: 100, reason: 'refund' })],
    });

    expect(ids(await svc.listSettlementDebts({ accountId: 'newBidder' }))).toEqual(['bid-flow']);
    expect(ids(await svc.listSettlementDebts({ accountId: 'outbidBidder' }))).toEqual(['bid-flow']);
    expect(await svc.listSettlementDebts({ accountId: 'someoneElse' })).toEqual([]);
  });

  it('matches an account named only by a compensation step', async () => {
    // An undecided flow owes its refund through the compensation plan, so a query that only looked at
    // `steps` would miss exactly the rows that are unwinding.
    await seedRow({
      _id: 'rollback-flow',
      kind: 'bid',
      actorId: 'bidder',
      decided: false,
      steps: [spendStep({ accountId: 'bidder' })],
      prefix: 1,
      started: { spend: 1 },
      done: { spend: 2 },
      compensation: [coinStep({ name: 'refundSelf', accountId: 'refundee', amount: 100, reason: 'refund', requires: 'spend' })],
    });

    expect(ids(await svc.listSettlementDebts({ accountId: 'refundee' }))).toEqual(['rollback-flow']);
  });

  it('clamps the limit and defaults it', async () => {
    for (let i = 0; i < 5; i++) await seedRow({ _id: `r-${i}`, attempts: 5 - i });

    expect(await svc.listSettlementDebts({ limit: 2 })).toHaveLength(2);
    expect(await svc.listSettlementDebts({ limit: 0 })).toHaveLength(1); // clamped up to 1, not "no rows"
    expect(await svc.listSettlementDebts({ limit: 9999 })).toHaveLength(5); // clamped down to the cap, still all 5
    expect(await svc.listSettlementDebts()).toHaveLength(5);
  });

  // ── Ordering ────────────────────────────────────────────────────────────────────────────────────

  it('puts the most-retried first, then the oldest — those are the two shapes worth a human', async () => {
    await seedRow({ _id: 'young-fail', attempts: 3, ts: nowMs });
    await seedRow({ _id: 'old-fail', attempts: 3, ts: nowMs - 100_000 });
    await seedRow({ _id: 'worst', attempts: 25, ts: nowMs });

    expect(ids(await svc.listSettlementDebts())).toEqual(['worst', 'old-fail', 'young-fail']);
  });

  // ── What each row reports ───────────────────────────────────────────────────────────────────────

  it('reports the forward plan for a committed settlement, minus what already landed', async () => {
    await seedRow({ done: { spend: 5 } });

    const [debt] = await svc.listSettlementDebts();
    expect(debt!.phase).toBe('forward');
    expect(debt!.owed.map((s) => s.name)).toEqual(['item', 'seller']);
    expect(debt!.completed).toEqual(['spend']);
  });

  it('reports the compensation for an uncommitted settlement, and only the parts that apply', async () => {
    // `requires` is what keeps this honest: a rollback will NOT refund an escrow that never went through,
    // so listing it as owed would show ops a debt the engine has no intention of paying.
    await seedRow({
      _id: 'partial-rollback',
      decided: false,
      prefix: 1,
      steps: [spendStep()],
      started: { spend: 1 },
      compensation: [
        coinStep({ name: 'refundSelf', amount: 100, reason: 'refund', requires: 'spend' }),
        { name: 'unclaim', key: 'k-unclaim', op: 'unclaim', auctionId: 'a:seller:1:1', buyerId: 'buyer' },
      ],
    });

    const [debt] = await svc.listSettlementDebts();
    expect(debt!.phase).toBe('rollback');
    expect(debt!.owed.map((s) => s.name)).toEqual(['unclaim']); // refundSelf skipped: the charge never landed

    // Once the charge is recorded as landed, the refund becomes a real debt.
    await mongo!.collections.auctionOrders.updateOne({ _id: 'partial-rollback' }, { $set: { 'done.spend': 9 } });
    const [after] = await svc.listSettlementDebts();
    expect(after!.owed.map((s) => s.name)).toEqual(['refundSelf', 'unclaim']);
  });

  it('flags a row stuck exactly at the shared threshold, so the logs and the console agree', async () => {
    // AUCTION_SETTLEMENT_STUCK_ATTEMPTS is also where journal.ts escalates its log level; one constant so
    // "loud in the logs" and "listed as stuck for ops" cannot drift into meaning different things.
    await seedRow({ _id: 'below', attempts: AUCTION_SETTLEMENT_STUCK_ATTEMPTS - 1 });
    await seedRow({ _id: 'at', attempts: AUCTION_SETTLEMENT_STUCK_ATTEMPTS });

    const byId = new Map((await svc.listSettlementDebts()).map((d) => [d.orderId, d]));
    expect(byId.get('below')!.stuck).toBe(false);
    expect(byId.get('at')!.stuck).toBe(true);
  });

  it('summarises each owed step by what it moves, and marks a local step as owing nobody', async () => {
    await seedRow({
      steps: [
        spendStep({ accountId: 'buyer', amount: 300, key: 'auction_buy:a:buyer' }),
        itemStep({ accountId: 'buyer', snapshot: { itemType: 'equipment', item: { instance: { id: 'e1', defId: 'wp_marker', level: 2 } }, qty: 1 } }),
        coinStep({ accountId: 'seller', amount: 270 }),
        { name: 'unclaim', key: 'k-unclaim', op: 'unclaim', auctionId: 'a:seller:1:1', buyerId: 'buyer' },
      ],
    });

    const [debt] = await svc.listSettlementDebts();
    expect(debt!.owed).toEqual([
      { name: 'spend', op: 'spend', key: 'auction_buy:a:buyer', accountId: 'buyer', amount: 300 },
      { name: 'item', op: 'mailItem', key: 'k-item', accountId: 'buyer', item: 'equipment wp_marker' },
      { name: 'seller', op: 'mailCoins', key: 'k-seller', accountId: 'seller', amount: 270 },
      { name: 'unclaim', op: 'unclaim', key: 'k-unclaim' },
    ]);
  });

  it('labels a stacked item with its quantity and an escrow step with its own snapshot', async () => {
    await seedRow({
      kind: 'list',
      steps: [
        { name: 'escrow', key: 'k-escrow', op: 'escrow', accountId: 'seller', snapshot: { itemType: 'material', item: { material: 'scrap' }, qty: 5 } },
      ],
      compensation: [],
    });

    const [debt] = await svc.listSettlementDebts();
    expect(debt!.owed[0]).toEqual({ name: 'escrow', op: 'escrow', key: 'k-escrow', accountId: 'seller', item: 'material scrap x5' });
  });

  it('falls back to the item type alone when a snapshot has no derivable name', async () => {
    await seedRow({
      steps: [itemStep({ snapshot: { itemType: 'skin', item: {}, qty: 1 } })],
    });
    expect((await svc.listSettlementDebts())[0]!.owed[0]!.item).toBe('skin');
  });

  it('carries the bookkeeping ops reads: order id, auction, flow kind, actor, cycle and timings', async () => {
    await seedRow({ _id: 'row-1', auctionId: 'a:s:9:9', kind: 'settle', actorId: 'seller', cycle: 2, ts: 111, nextAttemptAt: 222, attempts: 4 });

    expect(await svc.listSettlementDebts()).toEqual([{
      orderId: 'row-1',
      auctionId: 'a:s:9:9',
      kind: 'settle',
      actorId: 'seller',
      phase: 'forward',
      owed: expect.any(Array),
      completed: [],
      attempts: 4,
      stuck: false,
      cycle: 2,
      createdAt: 111,
      nextAttemptAt: 222,
    }]);
  });

  // ── Against the real engine ─────────────────────────────────────────────────────────────────────

  it('a real sale whose delivery mail is failing shows up as owed, and disappears once it lands', async () => {
    balances.set('bob', 10_000);
    const view = await svc.createAuction({
      sellerId: 'alice', itemType: 'material', item: { material: 'scrap' }, qty: 3, price: 10, durationSec: DUR,
    });
    mailFaults.set(`${view.auctionId}:bob:item`, 1);
    await svc.buyAuction('bob', view.auctionId);

    const [debt] = await svc.listSettlementDebts();
    expect(debt!.kind).toBe('buy');
    expect(debt!.actorId).toBe('bob');
    expect(debt!.phase).toBe('forward');
    expect(debt!.completed).toContain('spend'); // bob paid…
    expect(debt!.owed.map((s) => s.name)).toEqual(['item', 'seller']); // …but owns nothing yet, and alice is unpaid
    expect(debt!.owed[0]).toMatchObject({ accountId: 'bob', item: 'material scrap x3' });
    const net = 30 - Math.floor(30 * AUCTION_TAX_RATE);
    expect(debt!.owed[1]).toMatchObject({ accountId: 'alice', amount: net });
    // Every key is a real downstream lookup string, not a synthetic label.
    expect(debt!.owed[0]!.key).toBe(`auction_buy:${view.auctionId}:bob:item`);

    nowMs += 60_000;
    await svc.sweepSettlements();
    expect(await svc.listSettlementDebts()).toEqual([]);
  });

  it('the listing lookup marks that same sale unsettled, then settled — the two views agree', async () => {
    balances.set('bob', 10_000);
    const view = await svc.createAuction({
      sellerId: 'alice', itemType: 'material', item: { material: 'scrap' }, qty: 1, price: 10, durationSec: DUR,
    });
    mailFaults.set(`${view.auctionId}:bob:item`, 1);
    await svc.buyAuction('bob', view.auctionId);

    const owed = await svc.queryListings({ sellerId: 'alice' });
    expect(owed[0]!.status).toBe('sold');
    // Omitted, not null: the admin view only carries settledAt once the hand-over actually happened, and
    // its ABSENCE on a closed listing is the signal ops reads.
    expect('settledAt' in owed[0]!).toBe(false);

    nowMs += 60_000;
    await svc.sweepSettlements();
    const settled = await svc.queryListings({ sellerId: 'alice' });
    expect(settled[0]!.settledAt).toBeGreaterThan(0);
    expect(await svc.listSettlementDebts()).toEqual([]);
  });
});
