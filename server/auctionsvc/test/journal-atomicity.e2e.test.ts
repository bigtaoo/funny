// Settlement journal end-to-end (U13 close-out, 2026-08-24): the cross-collection idempotency and
// rollback behaviour that single-document CAS could not provide, against real Mongo.
//
// Two things make this file different from auction.e2e.test.ts, and both are deliberate:
//
//  1. **The downstream fakes are faithful, not permissive.** `commercial.spend` here reproduces the real
//     service's insert-first orderId slot AND its cross-account ownership guard, tracks a balance, and
//     records every actual debit; the mail fake dedupes on dispatchKey and can be told to fail a specific
//     hand-over N times. Every bug this round fixed was invisible to a fake that merely appended to an
//     array — a shared orderId looks like two happy calls unless the fake actually dedupes.
//
//  2. **Concurrency is injected inside the read→write window, never simulated by calling twice.** Two
//     sequential calls are not a race: they pass just as happily against the broken code, which is how the
//     2026-08-24 worldsvc sweep shipped two tests that could not fail. Each race here hooks the exact
//     compare-and-swap it is about and performs a genuine competing write while the caller is mid-flight.
//
// Crash recovery is modelled the same way — by producing the state a dead process actually leaves behind
// (a pending row with a step recorded as attempted-but-unresolved, or a listing closed with no journal row
// at all) and then letting the scheduler's sweep run against it.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUCTION_DURATIONS_SEC,
  AUCTION_TAX_RATE,
  SlgError,
  type CardInstance,
  type EquipmentInstance,
} from '@nw/shared';
import { createAuctionMongo, type AuctionCollections, type AuctionMongo } from '../src/db';
import { AuctionService } from '../src/auctionService';
import type { AuctionCommercialClient } from '../src/commercialClient';
import type { AuctionMetaClient } from '../src/metaClient';
import type { AuctionMailClient, AuctionMailContent } from '../src/mailClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_auction_journal_e2e_test';

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
  console.warn(`[auctionsvc.journal.e2e] Mongo unreachable (${URI}) — skipping.`);
}

describe.skipIf(!mongo)('auction settlement journal e2e', () => {
  const DUR = AUCTION_DURATIONS_SEC[0]!;

  // ── commercial fake: real insert-first orderId slot + cross-account ownership guard ──────────────
  /** orderId → the account that claimed it. Reproducing this is the point: a shared key is only visible through it. */
  const orderSlots = new Map<string, { account: string; amount: number }>();
  /** Every debit that actually moved coins (a deduped replay does NOT appear here). */
  const debits: Array<{ account: string; amount: number; orderId: string }> = [];
  const balances = new Map<string, number>();
  /** When set, every spend throws this instead of running (transport vs business failure is the caller's choice). */
  let spendFault: (() => Error) | null = null;

  const commercial: AuctionCommercialClient = {
    available: true,
    async spend(accountId, amount, orderId) {
      if (spendFault) throw spendFault();
      const existing = orderSlots.get(orderId);
      if (existing) {
        // commercial/src/service/shop.ts: a replay under someone else's key is refused outright, and an
        // own-account replay returns success WITHOUT debiting again.
        if (existing.account !== accountId) throw new SlgError('BAD_REQUEST', 'order belongs to another account');
        return;
      }
      orderSlots.set(orderId, { account: accountId, amount });
      const balance = balances.get(accountId) ?? 0;
      if (balance < amount) {
        orderSlots.delete(orderId); // commercial releases the slot so a later top-up can retry the same key
        throw new SlgError('INSUFFICIENT_FUNDS');
      }
      balances.set(accountId, balance - amount);
      debits.push({ account: accountId, amount, orderId });
    },
  };

  // ── mail fake: dispatchKey dedupe + per-key fault injection ──────────────────────────────────────
  const mailbox = new Map<string, { account: string; content: AuctionMailContent }>();
  /** dispatchKey substring → how many more sends matching it must fail. Models a flaky/erroring meta. */
  const mailFaults = new Map<string, number>();
  const mail: AuctionMailClient = {
    available: true,
    async sendSystemMail(accountId, dispatchKey, content) {
      for (const [fragment, remaining] of mailFaults) {
        if (remaining > 0 && dispatchKey.includes(fragment)) {
          mailFaults.set(fragment, remaining - 1);
          throw new Error(`meta 500 for ${dispatchKey}`);
        }
      }
      if (!mailbox.has(dispatchKey)) mailbox.set(dispatchKey, { account: accountId, content });
    },
  };
  const coinMailTo = (account: string) =>
    [...mailbox.values()].filter((m) => m.account === account && m.content.attachments?.[0]?.kind === 'coins');

  // ── meta fake: orderId-deduped escrow/grant over real inventories ────────────────────────────────
  const equipInv = new Map<string, Map<string, EquipmentInstance>>();
  const cardInv = new Map<string, Map<string, CardInstance>>();
  const skinInv = new Map<string, Set<string>>();
  const materialInv = new Map<string, number>();
  const metaOrders = new Set<string>();
  const mkEquip = (id: string): EquipmentInstance =>
    ({ id, defId: 'wp_marker', level: 0, rarity: 'common', affixes: [] }) as unknown as EquipmentInstance;
  const seedEquip = (account: string, inst: EquipmentInstance): void => {
    if (!equipInv.has(account)) equipInv.set(account, new Map());
    equipInv.get(account)!.set(inst.id, inst);
  };

  const meta: AuctionMetaClient = {
    available: true,
    async deductMaterial(accountId, _material, qty, orderId) {
      if (metaOrders.has(orderId)) return;
      metaOrders.add(orderId);
      materialInv.set(accountId, (materialInv.get(accountId) ?? 0) - qty);
    },
    async grantMaterial(accountId, _material, qty, orderId) {
      if (metaOrders.has(orderId)) return;
      metaOrders.add(orderId);
      materialInv.set(accountId, (materialInv.get(accountId) ?? 0) + qty);
    },
    async escrowEquipment(accountId, instanceId) {
      const inv = equipInv.get(accountId);
      const inst = inv?.get(instanceId);
      if (!inst) throw new SlgError('EQUIP_NOT_FOUND');
      inv!.delete(instanceId);
      return inst;
    },
    async grantEquipment(accountId, instance, orderId) {
      if (metaOrders.has(orderId)) return;
      metaOrders.add(orderId);
      seedEquip(accountId, instance);
    },
    async escrowCard(accountId, instanceId) {
      const inv = cardInv.get(accountId);
      const inst = inv?.get(instanceId);
      if (!inst) throw new SlgError('CARD_NOT_FOUND');
      inv!.delete(instanceId);
      return inst;
    },
    async grantCard(accountId, instance, orderId) {
      if (metaOrders.has(orderId)) return;
      metaOrders.add(orderId);
      if (!cardInv.has(accountId)) cardInv.set(accountId, new Map());
      cardInv.get(accountId)!.set(instance.id, instance);
    },
    async escrowSkin(accountId, skinId) {
      const inv = skinInv.get(accountId);
      if (!inv?.has(skinId)) throw new SlgError('SKIN_NOT_FOUND');
      inv.delete(skinId);
      return skinId;
    },
    async grantSkin(accountId, skinId, orderId) {
      if (metaOrders.has(orderId)) return;
      metaOrders.add(orderId);
      if (!skinInv.has(accountId)) skinInv.set(accountId, new Set());
      skinInv.get(accountId)!.add(skinId);
    },
  };

  let svc: AuctionService;
  let nowMs = Date.now();
  const deps = () => ({ cols: mongo!.collections, commercial, meta, mail, now: () => nowMs });

  /**
   * A service whose `cols[col][method]` runs `hook` immediately BEFORE delegating (hook returns true to
   * fail the call outright, modelling a process that died right there).
   *
   * Hooking the operation itself is what makes these races real: it drops a competing write into the gap
   * between the caller's read and its compare-and-swap, which a second sequential API call can never do —
   * that one is stopped by the cheap up-front status check and never reaches the CAS at all.
   */
  function svcWithHook<K extends keyof AuctionCollections>(
    col: K,
    method: string,
    hook: (args: unknown[]) => Promise<boolean | void>,
  ): AuctionService {
    const real = mongo!.collections[col];
    const patched = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop !== method) return Reflect.get(target, prop, receiver);
        return async (...args: unknown[]) => {
          if (await hook(args)) throw new Error('simulated process death');
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (target as any)[method](...args);
        };
      },
    });
    return new AuctionService({ ...deps(), cols: { ...mongo!.collections, [col]: patched } });
  }

  beforeEach(async () => {
    for (const c of Object.values(mongo!.collections)) await c.deleteMany({});
    orderSlots.clear();
    debits.length = 0;
    balances.clear();
    spendFault = null;
    mailbox.clear();
    mailFaults.clear();
    equipInv.clear();
    cardInv.clear();
    skinInv.clear();
    materialInv.clear();
    metaOrders.clear();
    nowMs = Date.now();
    svc = new AuctionService(deps());
  });

  afterAll(async () => {
    await mongo?.close();
  });

  // scrap's static reference unit price is 10 and the G guardrail band is ref x [0.5, 2.0], so every
  // unit price here has to sit in [5, 20] or createAuction/placeBid rejects with PRICE_OUT_OF_RANGE.
  const listMaterial = async (price = 10, qty = 1) =>
    svc.createAuction({ sellerId: 'alice', itemType: 'material', item: { material: 'scrap' }, qty, price, durationSec: DUR });

  const listAuctionMode = async (startPrice = 10, buyoutPrice?: number) =>
    svc.createAuction({
      sellerId: 'alice', itemType: 'material', item: { material: 'scrap' }, qty: 1,
      saleMode: 'auction', startPrice, ...(buyoutPrice != null ? { buyoutPrice } : {}), durationSec: DUR,
    });

  /** Let every pending row become sweep-eligible (past the claim grace window and its backoff). */
  const advancePastGrace = () => { nowMs += 60_000; };

  // ── 1. The two malformed idempotency keys ───────────────────────────────────────────────────────

  it('two buyers racing one fixed listing: exactly one is charged, and the loser never touches the winner\'s order slot', async () => {
    balances.set('bob', 1000);
    balances.set('carol', 1000);
    const view = await listMaterial();

    // carol's purchase lands in the window between bob's doc read and his claim CAS.
    let raced = false;
    const bobSvc = svcWithHook('auctions', 'findOneAndUpdate', async () => {
      if (raced) return;
      raced = true;
      await new AuctionService(deps()).buyAuction('carol', view.auctionId);
    });

    await expect(bobSvc.buyAuction('bob', view.auctionId)).rejects.toMatchObject({ code: 'AUCTION_CLOSED' });
    expect(raced).toBe(true);

    // Pre-fix, both buyers derived the SAME orderId (`auction_buy:{id}`, no buyer in it): carol claimed the
    // slot, so bob's spend hit commercial's cross-account guard and surfaced as a bare BAD_REQUEST instead
    // of "already sold" — and had bob won that race instead, carol's refund would have deduped into his.
    expect(debits).toHaveLength(1);
    expect(debits[0]!.account).toBe('carol');
    expect(debits[0]!.orderId).toContain('carol');
    expect(balances.get('bob')).toBe(1000); // never charged, so nothing to refund
    expect(coinMailTo('bob')).toHaveLength(0);
  });

  it('two identical concurrent bids from one bidder: charged once, and no refund is minted against that single charge', async () => {
    balances.set('bob', 1000);
    const view = await listAuctionMode();

    // The second attempt is injected INSIDE the first one's journal-claim -> topBid-CAS window, not run
    // beside it via Promise.all. This file's own header says why, and this case learned it the hard way:
    // it used to be `Promise.allSettled([placeBid, placeBid])` asserting exactly one fulfilled, which is an
    // assertion about a specific interleaving. Both orderings are legal — if the first attempt finishes
    // before the second calls `begin`, the second finds a `done` row and returns `state:'replay'`, i.e. it
    // ALSO fulfils (harmlessly: replay moves nothing). So the old assertion was a coin flip that failed
    // roughly one run in twenty and got papered over by `retry: 1`. The money invariants below held in
    // both orderings the whole time; only the outcome count was nondeterministic. See the sibling case
    // below for the replay ordering, pinned separately.
    let raced = false;
    let secondOutcome: PromiseSettledResult<unknown> | null = null;
    const bidSvc = svcWithHook('auctions', 'findOneAndUpdate', async () => {
      if (raced) return;
      raced = true;
      [secondOutcome] = await Promise.allSettled([new AuctionService(deps()).placeBid('bob', view.auctionId, 10)]);
    });

    await expect(bidSvc.placeBid('bob', view.auctionId, 10)).resolves.toMatchObject({ auctionId: view.auctionId });
    expect(raced).toBe(true);
    // The first attempt still holds a `pending` row well inside CLAIM_GRACE_MS, so the second is turned away
    // at `begin` before it can charge anything — the one branch that actually mattered pre-fix.
    expect(secondOutcome).toMatchObject({ status: 'rejected', reason: { code: 'REV_CONFLICT' } });

    // Pre-fix both attempts shared `auction_bid:{id}:bob:100`, so commercial charged once while the CAS
    // loser mailed bob a full refund against it — 100 coins created from nothing.
    expect(debits.filter((d) => d.account === 'bob')).toHaveLength(1);
    const refunded = coinMailTo('bob').reduce((n, m) => n + (m.content.attachments![0]!.count ?? 0), 0);
    expect(refunded).toBe(0);
    expect(balances.get('bob')).toBe(990);
  });

  it('the other ordering of those two bids — snapshot read first, journal claim after the winner finished — replays for free', async () => {
    // This is the interleaving that made the case above flaky, pinned instead of left to the scheduler.
    // It cannot be written sequentially: once the first bid lands, `topBid` is 10, so a resubmitted 10
    // dies at the minimum-increment check long before `journal.begin` — the replay branch is only
    // reachable by a caller that took its snapshot while `topBid` was still null. So the injection point
    // is the loser's OWN snapshot read: take it, then let the winner run to completion, then hand the
    // stale doc back and let the loser walk into `begin` against a row that is already `done`.
    //
    // `svcWithHook` cannot express this — its hook always runs BEFORE the real call, and here the read has
    // to happen first — hence the local proxy.
    balances.set('bob', 1000);
    const view = await listAuctionMode();

    let interleaved = false;
    const auctions = new Proxy(mongo!.collections.auctions, {
      get(target, prop, receiver) {
        if (prop !== 'findOne') return Reflect.get(target, prop, receiver);
        return async (...args: unknown[]) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const stale = await (target as any).findOne(...args);
          if (!interleaved) {
            interleaved = true;
            await new AuctionService(deps()).placeBid('bob', view.auctionId, 10); // the winner, start to finish
          }
          return stale;
        };
      },
    });
    const loserSvc = new AuctionService({ ...deps(), cols: { ...mongo!.collections, auctions } });

    // Resolves rather than throwing: `begin` reports `state:'replay'` for a row that already reached `done`.
    await expect(loserSvc.placeBid('bob', view.auctionId, 10)).resolves.toMatchObject({ auctionId: view.auctionId });
    expect(interleaved).toBe(true);

    // The whole point: a replay must move nothing. One charge, no refund mail, and the listing still shows
    // the single bid the winner recorded.
    expect(debits.filter((d) => d.account === 'bob')).toHaveLength(1);
    expect(coinMailTo('bob')).toHaveLength(0);
    expect(balances.get('bob')).toBe(990);
    const doc = await mongo!.collections.auctions.findOne({ _id: view.auctionId });
    expect(doc?.topBid).toMatchObject({ bidderId: 'bob', amount: 10 });
  });

  // ── 2. The missing rev guard on auction-win settlement ──────────────────────────────────────────

  it('a bid landing between the expiry scan and the settle CAS is not settled against the stale top bid', async () => {
    balances.set('bob', 10_000);
    balances.set('carol', 10_000);
    const view = await listAuctionMode();
    await svc.placeBid('bob', view.auctionId, 10);

    // Expire the listing, then let carol outbid inside the scanner's read→settle window. placeBid checks
    // expiry, so carol's bid has to be applied as a direct write — which is exactly what a bid that was
    // already in flight when the listing expired looks like from the scanner's side.
    nowMs += DUR * 1000 + 1000;
    let raced = false;
    const scanSvc = svcWithHook('auctions', 'findOneAndUpdate', async () => {
      if (raced) return;
      raced = true;
      await commercial.spend('carol', 20, `auction_bid:${view.auctionId}:carol:20`);
      await mongo!.collections.auctions.updateOne(
        { _id: view.auctionId },
        { $set: { topBid: { bidderId: 'carol', amount: 20, ts: nowMs }, price: 20 }, $inc: { rev: 1 } },
      );
    });

    await scanSvc.processExpiredAuctions();
    expect(raced).toBe(true);

    // Pre-fix the CAS filter was `{status:'open'}` alone, so this settled against bob — who by then had
    // been refunded — while carol's 20-coin escrow was orphaned. The rev guard makes the claim fail
    // instead, leaving the listing open for the next tick to settle with a fresh snapshot.
    const stalled = await mongo!.collections.auctions.findOne({ _id: view.auctionId });
    expect(stalled?.status).toBe('open');
    expect(mailbox.has(`auction_settle:${view.auctionId}:item`)).toBe(false);

    // Next tick sees carol's bid and settles to her.
    expect(await svc.processExpiredAuctions()).toBe(1);
    const settled = await mongo!.collections.auctions.findOne({ _id: view.auctionId });
    expect(settled?.status).toBe('sold');
    expect(settled?.buyerId).toBe('carol');
    expect(mailbox.get(`auction_settle:${view.auctionId}:item`)?.account).toBe('carol');
  });

  // ── 3. Crash recovery ───────────────────────────────────────────────────────────────────────────

  it('a process death between escrow and listing insert gives the item back (it used to be destroyed)', async () => {
    seedEquip('alice', mkEquip('eq1'));
    const crashing = svcWithHook('auctions', 'insertOne', async () => true);

    await expect(crashing.createAuction({
      sellerId: 'alice', itemType: 'equipment', item: { instanceId: 'eq1' }, qty: 1, price: 400, durationSec: DUR,
    })).rejects.toThrow('simulated process death');

    // The state a dead process leaves: escrow done, no listing, nobody holding the item.
    expect(equipInv.get('alice')?.has('eq1')).toBe(false);
    expect(await mongo!.collections.auctions.countDocuments({})).toBe(0);

    advancePastGrace();
    await svc.sweepSettlements();

    expect(equipInv.get('alice')?.has('eq1')).toBe(true);
    const row = await mongo!.collections.auctionOrders.findOne({ kind: 'list' });
    expect(row?.status).toBe('aborted');
  });

  it('a process death between the purchase claim and the charge releases the listing', async () => {
    balances.set('bob', 1000);
    const view = await listMaterial();
    // Die on the journal write that records "the branch is past" — i.e. after the listing was claimed but
    // before any coins moved. `prefix: 0` on the buy plan is what tells the resumer bob was never charged.
    const crashing = svcWithHook('auctionOrders', 'updateOne', async (args) => {
      const update = args[1] as { $set?: Record<string, unknown> };
      return update.$set?.['decided'] === true;
    });

    await expect(crashing.buyAuction('bob', view.auctionId)).rejects.toThrow('simulated process death');
    expect((await mongo!.collections.auctions.findOne({ _id: view.auctionId }))?.status).toBe('sold');

    advancePastGrace();
    await svc.sweepSettlements();

    const released = await mongo!.collections.auctions.findOne({ _id: view.auctionId });
    expect(released?.status).toBe('open');
    expect(released?.buyerId).toBeUndefined();
    expect(debits).toHaveLength(0);
    // The listing is genuinely buyable again — the pre-fix failure mode was the opposite: the order slot
    // stayed owned by a buyer who never got the item, so nobody could ever buy this listing again.
    const bought = await svc.buyAuction('bob', view.auctionId);
    expect(bought.status).toBe('sold');
    expect(debits).toHaveLength(1);
  });

  it('a settlement whose process died before the journal row existed is rebuilt from the listing itself', async () => {
    balances.set('bob', 10_000);
    const view = await listAuctionMode(10, 20);
    // Buyout settles immediately; wipe the journal row and the settled marker to reproduce a crash in the
    // gap between the claim (which flips the listing to sold) and the row that records what it owes.
    await svc.placeBid('bob', view.auctionId, 20);
    mailbox.clear();
    await mongo!.collections.auctionOrders.deleteMany({ kind: 'settle' });
    await mongo!.collections.auctions.updateOne({ _id: view.auctionId }, { $unset: { settledAt: '' } });

    advancePastGrace();
    const { repaired } = await svc.sweepSettlements();
    expect(repaired).toBe(1);

    // Item to the winner, post-tax proceeds to the seller, and the listing marked settled.
    const total = 20;
    expect(mailbox.get(`auction_settle:${view.auctionId}:item`)?.account).toBe('bob');
    expect(mailbox.get(`auction_settle:${view.auctionId}:seller`)?.content.attachments?.[0]?.count)
      .toBe(total - Math.floor(total * AUCTION_TAX_RATE));
    expect((await mongo!.collections.auctions.findOne({ _id: view.auctionId }))?.settledAt).toBeGreaterThan(0);
  });

  it('a return mail that meta keeps refusing stays owed and is retried until it lands', async () => {
    const view = await listMaterial();
    mailFaults.set(`auction_cancel:${view.auctionId}`, 2); // fail the first two attempts

    // The seller's cancel succeeds — the item is theirs either way, so a failing hand-over must not be
    // reported as a failed cancel. Pre-fix this mail was best-effort and a single refusal destroyed it.
    const cancelled = await svc.cancelAuction('alice', view.auctionId);
    expect(cancelled.status).toBe('cancelled');
    expect(mailbox.size).toBe(0);
    expect((await mongo!.collections.auctions.findOne({ _id: view.auctionId }))?.settledAt).toBeUndefined();

    advancePastGrace();
    await svc.sweepSettlements(); // attempt 2 — still failing
    expect(mailbox.size).toBe(0);

    advancePastGrace();
    await svc.sweepSettlements(); // attempt 3 — lands
    expect(mailbox.get(`auction_cancel:${view.auctionId}`)?.content.attachments?.[0])
      .toMatchObject({ kind: 'material', count: 1 });
    const row = await mongo!.collections.auctionOrders.findOne({ _id: `auction_cancel:${view.auctionId}` });
    expect(row?.status).toBe('done');
    expect((await mongo!.collections.auctions.findOne({ _id: view.auctionId }))?.settledAt).toBeGreaterThan(0);
  });

  it('an outbid refund whose mail fails is retried rather than lost', async () => {
    balances.set('bob', 10_000);
    balances.set('carol', 10_000);
    const view = await listAuctionMode();
    await svc.placeBid('bob', view.auctionId, 10);
    mailFaults.set('auction_bid_refund', 1);

    // carol outbids bob. bob's escrow refund is owed; the first send fails.
    await svc.placeBid('carol', view.auctionId, 20);
    expect(coinMailTo('bob')).toHaveLength(0);

    advancePastGrace();
    await svc.sweepSettlements();

    expect(coinMailTo('bob')).toHaveLength(1);
    expect(coinMailTo('bob')[0]!.content.attachments?.[0]?.count).toBe(10);
  });

  // ── 4. Reopen on a fresh cycle ──────────────────────────────────────────────────────────────────

  it('retrying a bid whose escrow was already refunded charges again instead of replaying the old order slot', async () => {
    balances.set('bob', 10_000);
    const view = await listAuctionMode();

    // First attempt: bob's escrow goes through, then his topBid write loses to a concurrent rev bump, so
    // the journal refunds him and aborts the row.
    let raced = false;
    const losing = svcWithHook('auctions', 'findOneAndUpdate', async () => {
      if (raced) return;
      raced = true;
      await mongo!.collections.auctions.updateOne({ _id: view.auctionId }, { $inc: { rev: 1 } });
    });
    await expect(losing.placeBid('bob', view.auctionId, 10)).rejects.toMatchObject({ code: 'AUCTION_CLOSED' });
    expect(debits).toHaveLength(1);
    expect(coinMailTo('bob')).toHaveLength(1);

    // Same bidder, same amount → same journal row id. Reusing its downstream key would hit commercial's
    // replay branch and return success WITHOUT debiting, leaving a top bid with no coins behind it. The
    // row's `cycle` advances on reopen precisely to prevent that.
    const retried = await svc.placeBid('bob', view.auctionId, 10);
    expect(retried.topBid).toMatchObject({ bidderId: 'bob', amount: 10 });
    expect(debits).toHaveLength(2);
    expect(debits[1]!.orderId).not.toBe(debits[0]!.orderId);
    expect(balances.get('bob')).toBe(9980); // charged twice, refunded once → 10 escrowed, 10 in the mail
    const row = await mongo!.collections.auctionOrders.findOne({ _id: `auction_bid:${view.auctionId}:bob:10` });
    expect(row?.cycle).toBe(1);
    expect(row?.status).toBe('done');
  });

  // ── 5. Migration + purge interaction ────────────────────────────────────────────────────────────

  it('pre-journal closed listings are stamped settled at boot, so the repair pass never re-delivers them', async () => {
    // A listing closed by the old code: terminal, no journal row, no settledAt. Re-driving it would send a
    // fresh attachment under the journal's dispatch key, turning an unfixable old loss into a duplication.
    await mongo!.collections.auctions.insertOne({
      _id: 'a:alice:1:1', sellerId: 'alice', itemType: 'material', item: { material: 'scrap' }, qty: 3,
      price: 10, currency: 'coins', expireAt: nowMs - 5000, closedAt: nowMs - 4000, status: 'expired',
      saleMode: 'fixed', rev: 2,
    });

    await mongo!.runMigrations();
    expect((await mongo!.collections.auctions.findOne({ _id: 'a:alice:1:1' }))?.settledAt).toBe(nowMs - 4000);

    advancePastGrace();
    const { repaired } = await svc.sweepSettlements();
    expect(repaired).toBe(0);
    expect(mailbox.size).toBe(0);
  });

  it('the retention purge refuses to delete a listing whose hand-over is still owed', async () => {
    const view = await listMaterial();
    mailFaults.set(`auction_expire:${view.auctionId}`, 99); // meta is down for good
    nowMs += DUR * 1000 + 1000;
    await svc.processExpiredAuctions();

    // Well past the retention window, but the seller has not been given their item back yet — deleting the
    // document would destroy the only record of that debt, since the sweep rebuilds the plan from it.
    nowMs += 400 * 24 * 3600 * 1000;
    expect(await svc.purgeClosedListings()).toBe(0);
    expect(await mongo!.collections.auctions.countDocuments({ _id: view.auctionId })).toBe(1);

    // Once it lands, the listing becomes purgeable again.
    mailFaults.clear();
    await svc.sweepSettlements();
    expect(mailbox.has(`auction_expire:${view.auctionId}`)).toBe(true);
    expect(await svc.purgeClosedListings()).toBe(1);
  });

  // ── 6. Duplicate-submission dedupe ──────────────────────────────────────────────────────────────

  it('a duplicate purchase submission while the first is still in flight is rejected, not charged twice', async () => {
    balances.set('bob', 1000);
    const view = await listMaterial();

    // Two requests for the same (listing, buyer) inside the claim grace window: the journal row id is the
    // dedupe identity, so the second one loses the insert race and is told to retry.
    const results = await Promise.allSettled([
      new AuctionService(deps()).buyAuction('bob', view.auctionId),
      new AuctionService(deps()).buyAuction('bob', view.auctionId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(debits).toHaveLength(1);
    expect(balances.get('bob')).toBe(990);
  });

  it('a completed purchase replayed under the same key returns the sale without charging again', async () => {
    balances.set('bob', 1000);
    const view = await listMaterial();
    const first = await svc.buyAuction('bob', view.auctionId);
    expect(first.status).toBe('sold');

    // The listing is closed, so the ordinary status check catches this long before the journal — but the
    // journal's replay branch is what makes the key safe to reuse at all, and the balance is the proof
    // that no second debit slipped through either path.
    await expect(svc.buyAuction('bob', view.auctionId)).rejects.toMatchObject({ code: 'AUCTION_CLOSED' });
    expect(debits).toHaveLength(1);
    expect(balances.get('bob')).toBe(990);
  });

  it('a sale delivers the item to the buyer and post-tax proceeds to the seller, and marks the listing settled', async () => {
    balances.set('bob', 1000);
    const view = await listMaterial(10, 3);
    await svc.buyAuction('bob', view.auctionId);

    const total = 30;
    expect(debits[0]).toMatchObject({ account: 'bob', amount: total });
    expect(mailbox.get(`auction_buy:${view.auctionId}:bob:item`)?.content.attachments?.[0])
      .toMatchObject({ kind: 'material', count: 3 });
    expect(mailbox.get(`auction_buy:${view.auctionId}:bob:seller`)?.content.attachments?.[0]?.count)
      .toBe(total - Math.floor(total * AUCTION_TAX_RATE));
    const stored = await mongo!.collections.auctions.findOne({ _id: view.auctionId });
    expect(stored?.settledAt).toBeGreaterThan(0);
  });

  it.each([
    {
      what: 'card',
      seed: () => cardInv.set('alice', new Map([['c1', { id: 'c1', defId: 'ch_ink', level: 1, gear: {} } as unknown as CardInstance]])),
      params: { itemType: 'card' as const, item: { instanceId: 'c1' } },
      held: () => cardInv.get('alice')?.has('c1') ?? false,
    },
    {
      what: 'skin',
      seed: () => skinInv.set('alice', new Set(['skin_notebook_blue'])),
      params: { itemType: 'skin' as const, item: { skinId: 'skin_notebook_blue' } },
      held: () => skinInv.get('alice')?.has('skin_notebook_blue') ?? false,
    },
  ])('a $what escrow orphaned by a dead listing insert is handed back too', async ({ seed, params, held }) => {
    seed();
    const crashing = svcWithHook('auctions', 'insertOne', async () => true);
    await expect(crashing.createAuction({ sellerId: 'alice', ...params, qty: 1, price: 10, durationSec: DUR }))
      .rejects.toThrow('simulated process death');
    expect(held()).toBe(false);

    advancePastGrace();
    await svc.sweepSettlements();

    expect(held()).toBe(true);
  });

  it('the repair pass leaves a pending purchase alone — resuming that row is the other pass\'s job', async () => {
    balances.set('bob', 1000);
    const view = await listMaterial();
    mailFaults.set(`auction_buy:${view.auctionId}:bob:item`, 2);

    // The sale went through (bob is charged and owns it); only the delivery mail is still owed, so the
    // listing sits at sold-with-no-settledAt — the same shape the repair pass scans for. It must not
    // rebuild a plan here: a buy always journals its intent before claiming, so a second plan would be a
    // second set of hand-overs for one purchase.
    await svc.buyAuction('bob', view.auctionId);
    expect(mailbox.has(`auction_buy:${view.auctionId}:bob:item`)).toBe(false);

    // First sweep: the mail still fails, so the row stays pending and the listing is still sold with no
    // `settledAt` when the repair pass runs — exactly the shape it scans for, and exactly the case it has
    // to walk past.
    advancePastGrace();
    const first = await svc.sweepSettlements();
    expect(first.resumed).toBe(1);
    expect(first.repaired).toBe(0);
    expect(mailbox.has(`auction_buy:${view.auctionId}:bob:item`)).toBe(false);
    expect((await mongo!.collections.auctions.findOne({ _id: view.auctionId }))?.settledAt).toBeUndefined();

    advancePastGrace();
    const second = await svc.sweepSettlements();
    expect(second.repaired).toBe(0);
    expect(mailbox.get(`auction_buy:${view.auctionId}:bob:item`)?.account).toBe('bob');
    // Exactly one purchase row — the repair pass did not mint a second plan for the same sale.
    expect(await mongo!.collections.auctionOrders.countDocuments({ auctionId: view.auctionId, kind: 'buy' })).toBe(1);
  });

  it('a row left behind by a dead process whose charge is then definitively refused is rolled back by the sweep', async () => {
    const view = await listMaterial();
    // Hand-crafted because this state only arises across a process boundary: an older instance claimed the
    // listing and recorded that it was past its branch, then died before its charge resolved. bob has no
    // balance, so when the sweep retries that charge commercial refuses it outright — a definitive answer,
    // which is what lets the rollback release the listing instead of leaving it in limbo.
    await mongo!.collections.auctions.updateOne(
      { _id: view.auctionId },
      { $set: { status: 'sold', buyerId: 'bob', soldAt: nowMs, closedAt: nowMs }, $inc: { rev: 1 } },
    );
    const rowId = `auction_buy:${view.auctionId}:bob`;
    await mongo!.collections.auctionOrders.insertOne({
      _id: rowId, auctionId: view.auctionId, kind: 'buy', actorId: 'bob', status: 'pending',
      steps: [
        { name: 'spend', key: rowId, op: 'spend', accountId: 'bob', amount: 10 },
        { name: 'item', key: `${rowId}:item`, op: 'mailItem', accountId: 'bob', snapshot: { itemType: 'material', item: { material: 'scrap' }, qty: 1 }, reason: 'sold' },
      ],
      prefix: 0,
      done: {}, started: {}, decided: true,
      compensation: [{ name: 'unclaim', key: `${rowId}:unclaim`, op: 'unclaim', auctionId: view.auctionId, buyerId: 'bob' }],
      cycle: 0, claimedAt: nowMs, attempts: 0, nextAttemptAt: nowMs, ts: nowMs,
    });

    advancePastGrace();
    const { resumed } = await svc.sweepSettlements();
    expect(resumed).toBe(1);

    const released = await mongo!.collections.auctions.findOne({ _id: view.auctionId });
    expect(released?.status).toBe('open');
    expect(mailbox.size).toBe(0);
    expect((await mongo!.collections.auctionOrders.findOne({ _id: rowId }))?.status).toBe('aborted');
  });

  it('a bid escrow with an UNKNOWN outcome is never refunded on a guess — it is retried until it answers', async () => {
    balances.set('bob', 10_000);
    const view = await listAuctionMode();

    // The single most dangerous shape in the whole flow: the debit request timed out, so commercial may or
    // may not have applied it. Refunding on the assumption it landed mints coins whenever it did not;
    // assuming it did not and recording the bid anyway leaves a top bid a settlement would pay out against
    // with nothing behind it. The only correct move is to keep asking.
    spendFault = () => new Error('socket hang up');
    await expect(svc.placeBid('bob', view.auctionId, 10)).rejects.toMatchObject({ code: 'REV_CONFLICT' });

    const rowId = `auction_bid:${view.auctionId}:bob:10`;
    let row = await mongo!.collections.auctionOrders.findOne({ _id: rowId });
    expect(row?.status).toBe('pending');
    expect(row?.decided).toBe(false);
    expect(row?.started['spend']).toBeGreaterThan(0); // attempted…
    expect(row?.done['spend']).toBeUndefined();       // …outcome unknown
    expect((await mongo!.collections.auctions.findOne({ _id: view.auctionId }))?.topBid).toBeUndefined();

    // Sweep while commercial is still unreachable: nothing may be refunded and nothing may be recorded.
    advancePastGrace();
    await svc.sweepSettlements();
    expect(coinMailTo('bob')).toHaveLength(0);
    expect(debits).toHaveLength(0);
    row = await mongo!.collections.auctionOrders.findOne({ _id: rowId });
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBeGreaterThan(1);

    // commercial comes back. The retry gets a definitive answer — the debit lands — and only now does the
    // rollback know there is something to hand back, because the bid itself was never recorded.
    spendFault = null;
    advancePastGrace();
    await svc.sweepSettlements();

    expect(debits).toHaveLength(1);
    expect(coinMailTo('bob')).toHaveLength(1);
    expect(coinMailTo('bob')[0]!.content.attachments?.[0]?.count).toBe(10);
    expect((await mongo!.collections.auctionOrders.findOne({ _id: rowId }))?.status).toBe('aborted');
    expect((await mongo!.collections.auctions.findOne({ _id: view.auctionId }))?.topBid).toBeUndefined();
  });

  it('a bid whose escrow is definitively refused records no bid and owes no refund', async () => {
    balances.set('bob', 5); // less than the 10-coin escrow
    const view = await listAuctionMode();

    await expect(svc.placeBid('bob', view.auctionId, 10)).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });

    expect(debits).toHaveLength(0);
    expect(coinMailTo('bob')).toHaveLength(0); // nothing was taken, so a refund would be minting coins
    expect((await mongo!.collections.auctions.findOne({ _id: view.auctionId }))?.topBid).toBeUndefined();
    const row = await mongo!.collections.auctionOrders.findOne({ _id: `auction_bid:${view.auctionId}:bob:10` });
    expect(row?.status).toBe('aborted');
  });

  it('a listing whose escrow outcome is unknown is neither listed nor handed back until commercial-side truth is known', async () => {
    seedEquip('alice', mkEquip('eq1'));
    // meta accepted the escrow request but the answer was lost. Handing the item back now would duplicate
    // it if the escrow did land; publishing the listing would sell an item that may still be in the
    // seller's inventory.
    let escrowCalls = 0;
    const flaky: AuctionMetaClient = {
      ...meta,
      async escrowEquipment(accountId, instanceId, orderId) {
        escrowCalls++;
        if (escrowCalls === 1) throw new Error('meta timeout');
        return meta.escrowEquipment(accountId, instanceId, orderId);
      },
    };
    const flakySvc = new AuctionService({ ...deps(), meta: flaky });

    await expect(flakySvc.createAuction({
      sellerId: 'alice', itemType: 'equipment', item: { instanceId: 'eq1' }, qty: 1, price: 10, durationSec: DUR,
    })).rejects.toMatchObject({ code: 'REV_CONFLICT' });

    expect(equipInv.get('alice')?.has('eq1')).toBe(true); // still the seller's — the escrow never resolved
    expect(await mongo!.collections.auctions.countDocuments({})).toBe(0);

    // The sweep asks again; meta answers this time, so the escrow lands and — since no listing exists —
    // the rollback hands the item straight back.
    advancePastGrace();
    await new AuctionService({ ...deps(), meta: flaky }).sweepSettlements();

    expect(equipInv.get('alice')?.has('eq1')).toBe(true);
    expect(await mongo!.collections.auctions.countDocuments({})).toBe(0);
    const row = await mongo!.collections.auctionOrders.findOne({ kind: 'list' });
    expect(row?.status).toBe('aborted');
  });

  it('a definitively-refused escrow surfaces its business code and leaves nothing to hand back', async () => {
    await expect(svc.createAuction({
      sellerId: 'alice', itemType: 'card', item: { instanceId: 'c1' }, qty: 1, price: 100, durationSec: DUR,
    })).rejects.toMatchObject({ code: 'CARD_NOT_FOUND' });
    const row = await mongo!.collections.auctionOrders.findOne({ kind: 'list' });
    expect(row?.status).toBe('aborted');
    expect(row?.done['escrow']).toBeUndefined(); // definitively never happened → nothing to hand back
  });
});
