// journal.ts + journalSteps.ts branch-coverage gap-fill (2026-09-03 branch-gate pass).
//
// journal-atomicity.e2e.test.ts covers the engine's happy and racing paths against real Mongo, but its
// races are all provoked through the SERVICE, so `begin`'s collision verdicts are only ever reached in
// the shapes a live flow produces. What was never executed:
//   • an `insertOne` failure that is NOT a duplicate key (a real Mongo error must propagate, not be
//     mistaken for "someone else holds the key");
//   • a key whose row has been TTL-purged between the failed insert and the read that follows it;
//   • a key whose row belongs to a different account (only reachable by hand-building a flow key,
//     which is exactly what `check:auctionjournal` exists to forbid);
//   • the two "still not resolvable" verdicts — a claim inside `CLAIM_GRACE_MS`, and a row another
//     caller reopened first;
//   • the escrow-snapshot substitution in a rollback, which is the difference between handing a
//     seller's equipment back and granting nothing at all;
//   • the escalated log line for a debt that has been retried past AUCTION_SETTLEMENT_STUCK_ATTEMPTS.
//
// The journal engine is constructed directly here (it is not a facade method), over stub collections.
import { describe, expect, it, vi } from 'vitest';
import { AUCTION_SETTLEMENT_STUCK_ATTEMPTS, SlgError, type EquipmentInstance } from '@nw/shared';
import { AuctionOrderJournal, CLAIM_GRACE_MS } from '../src/auctionService/journal';
import { AuctionOrderStepRunner } from '../src/auctionService/journalSteps';
import { planForBuy, planForList, snapshotOf } from '../src/auctionService/journalPlans';
import type { AuctionOrderDoc } from '../src/db';
import { dupKeyError, mkOrder, NOW, stubDeps } from './stubDeps';

const AID = 'a:seller-1:1:1';
const SNAP = { itemType: 'material', item: { material: 'scrap' }, qty: 2 };
const buyPlan = (rowId: string, cycle: number) => planForBuy(rowId, cycle, 'buyer-1', 'seller-1', AID, SNAP, 200, 180);

/** `findOne` over a scripted sequence of rows (the last value repeats). */
function rowReads(...rows: Array<AuctionOrderDoc | null>) {
  let i = 0;
  return async () => rows[Math.min(i++, rows.length - 1)] ?? null;
}

describe('journal.begin: what an insert-first collision resolves to', () => {
  it('a non-duplicate-key insert failure propagates untouched', async () => {
    const { deps } = stubDeps({ cols: { auctionOrders: { insertOne: async () => { throw new Error('not primary'); } } } });
    const journal = new AuctionOrderJournal(deps);
    await expect(journal.begin('row-1', 'buy', AID, 'buyer-1', (c) => buyPlan('row-1', c)))
      .rejects.toThrow('not primary');
  });

  it('a row that has been TTL-purged since the failed insert -> inflight (nothing to replay)', async () => {
    const { deps } = stubDeps({
      cols: { auctionOrders: { insertOne: async () => { throw dupKeyError(); }, findOne: rowReads(null) } },
    });
    const journal = new AuctionOrderJournal(deps);
    expect(await journal.begin('row-1', 'buy', AID, 'buyer-1', (c) => buyPlan('row-1', c))).toEqual({ state: 'inflight' });
  });

  it('a key owned by another account is refused rather than replayed', async () => {
    const { deps } = stubDeps({
      cols: {
        auctionOrders: {
          insertOne: async () => { throw dupKeyError(); },
          findOne: rowReads(mkOrder({ actorId: 'someone-else', status: 'done' })),
        },
      },
    });
    const journal = new AuctionOrderJournal(deps);
    await expect(journal.begin('row-1', 'buy', AID, 'buyer-1', (c) => buyPlan('row-1', c)))
      .rejects.toThrow(SlgError);
  });

  it('a claim younger than CLAIM_GRACE_MS -> inflight, and the live attempt is not resumed underneath it', async () => {
    const resumable = mkOrder({ status: 'pending', claimedAt: NOW - (CLAIM_GRACE_MS - 1), decided: true });
    const updateOne = vi.fn(async () => ({ acknowledged: true }));
    const { deps } = stubDeps({
      cols: { auctionOrders: { insertOne: async () => { throw dupKeyError(); }, findOne: rowReads(resumable), updateOne } },
    });
    const journal = new AuctionOrderJournal(deps);
    expect(await journal.begin('row-1', 'buy', AID, 'buyer-1', (c) => buyPlan('row-1', c))).toEqual({ state: 'inflight' });
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('an abandoned row that is still pending after being resumed -> inflight (attempts are not stacked)', async () => {
    const stale = () => mkOrder({ status: 'pending', claimedAt: NOW - CLAIM_GRACE_MS - 1 });
    const { deps } = stubDeps({
      cols: {
        auctions: { updateOne: async () => ({ acknowledged: true }) },
        auctionOrders: {
          insertOne: async () => { throw dupKeyError(); },
          // Read twice — once to inspect the collision, once after the resume attempt — and the second
          // read must be a distinct document: the point of the branch is a row the resume did NOT resolve.
          findOne: rowReads(stale(), stale()),
          updateOne: async () => ({ acknowledged: true }),
        },
      },
    });
    const journal = new AuctionOrderJournal(deps);
    expect(await journal.begin('row-1', 'buy', AID, 'buyer-1', (c) => buyPlan('row-1', c))).toEqual({ state: 'inflight' });
  });

  it('an abandoned row whose document vanished during the resume is judged on what it last read', async () => {
    // The re-read after `resume` can come back empty (the row went terminal and was TTL-purged, or the
    // resume itself removed it); falling back to the row in hand is what keeps the verdict defined.
    const stale = mkOrder({ status: 'pending', claimedAt: NOW - CLAIM_GRACE_MS - 1 });
    const { deps } = stubDeps({
      cols: {
        auctions: { updateOne: async () => ({ acknowledged: true }) },
        auctionOrders: {
          insertOne: async () => { throw dupKeyError(); },
          findOne: rowReads(stale, null),
          updateOne: async () => ({ acknowledged: true }),
          findOneAndUpdate: async () => null,
        },
      },
    });
    const journal = new AuctionOrderJournal(deps);
    // The rollback drove `stale` to `aborted` in place, so the reopen path runs and loses its CAS.
    expect(await journal.begin('row-1', 'buy', AID, 'buyer-1', (c) => buyPlan('row-1', c))).toEqual({ state: 'inflight' });
  });

  it('an aborted row another caller reopened first -> inflight (the reopen CAS is the arbiter)', async () => {
    const { deps } = stubDeps({
      cols: {
        auctionOrders: {
          insertOne: async () => { throw dupKeyError(); },
          findOne: rowReads(mkOrder({ status: 'aborted', cycle: 0 })),
          findOneAndUpdate: async () => null,
        },
      },
    });
    const journal = new AuctionOrderJournal(deps);
    expect(await journal.begin('row-1', 'buy', AID, 'buyer-1', (c) => buyPlan('row-1', c))).toEqual({ state: 'inflight' });
  });

  it('an aborted row this caller wins reopens on the next cycle, re-keying every downstream call', async () => {
    let reopenedWith: Record<string, unknown> | undefined;
    const { deps } = stubDeps({
      cols: {
        auctionOrders: {
          insertOne: async () => { throw dupKeyError(); },
          findOne: rowReads(mkOrder({ status: 'aborted', cycle: 0 })),
          findOneAndUpdate: async (_f: unknown, u: { $set: Record<string, unknown> }) => {
            reopenedWith = u.$set;
            return mkOrder({ status: 'pending', cycle: 1, ...u.$set });
          },
        },
      },
    });
    const journal = new AuctionOrderJournal(deps);
    const begun = await journal.begin('row-1', 'buy', AID, 'buyer-1', (c) => buyPlan('row-1', c));
    expect(begun.state).toBe('fresh');
    // cycle 1 suffixes the keys, so commercial cannot dedupe the retry against the refunded attempt.
    expect((reopenedWith!['steps'] as Array<{ key: string }>)[0]!.key).toBe('row-1#1');
  });
});

describe('journal.resume', () => {
  it('a row that is no longer pending is returned untouched', async () => {
    const done = mkOrder({ status: 'done' });
    const updateOne = vi.fn(async () => ({ acknowledged: true }));
    const { deps } = stubDeps({ cols: { auctionOrders: { updateOne } } });
    expect(await new AuctionOrderJournal(deps).resume(done)).toBe(done);
    expect(updateOne).not.toHaveBeenCalled();
  });
});

describe('journal rollback: hand back what was escrowed, not what was requested', () => {
  it('a create-listing rollback grants the resolved instance, not the bare instanceId the seller sent', async () => {
    // The requested payload only carries `instanceId`; meta answers the escrow with the full instance,
    // and that snapshot is the only thing grantEquipment can act on — rolling back with the requested
    // payload silently grants nothing, which is how a seller's equipment used to vanish.
    const instance = { id: 'eq-1', defId: 'wp_marker', level: 0, rarity: 'common', affixes: [] } as unknown as EquipmentInstance;
    const granted: EquipmentInstance[] = [];
    const rowId = 'auction_list:' + AID;
    const requested = snapshotOf({ itemType: 'equipment', item: { instanceId: 'eq-1' }, qty: 1 });
    const { deps } = stubDeps({
      cols: { auctionOrders: { insertOne: async () => ({ acknowledged: true }), updateOne: async () => ({ acknowledged: true }), findOne: rowReads(null) } },
      meta: {
        async escrowEquipment() { return instance; },
        async grantEquipment(_acct: string, inst: EquipmentInstance) { granted.push(inst); },
      },
    });
    const journal = new AuctionOrderJournal(deps);
    const begun = await journal.begin(rowId, 'list', AID, 'seller-1', (c) => planForList(rowId, c, 'seller-1', requested));
    expect(begun.state).toBe('fresh');
    const row = (begun as { row: AuctionOrderDoc }).row;
    await journal.advance(row);
    await journal.abort(row);
    expect(granted).toEqual([instance]);
  });

  it('a coin compensation is NOT rewritten with the escrow snapshot — only item hand-overs are', async () => {
    // The substitution is scoped to `grant`/`mailItem` on purpose: a refund carries an amount, and
    // pushing an item snapshot into it would be meaningless at best.
    const rowId = 'auction_bid:' + AID + ':bidder-1:60';
    const { deps, mails } = stubDeps({
      cols: { auctionOrders: { updateOne: async () => ({ acknowledged: true }), findOne: rowReads(null) } },
    });
    const row = mkOrder({
      _id: rowId,
      kind: 'bid',
      actorId: 'bidder-1',
      prefix: 0,
      done: { spend: NOW },
      escrowed: { itemType: 'equipment', item: { instance: { id: 'eq-1' } }, qty: 1 },
      compensation: [{ name: 'refundSelf', op: 'mailCoins', key: rowId + ':refund', requires: 'spend', accountId: 'bidder-1', amount: 120, reason: 'refund' }],
    });
    await new AuctionOrderJournal(deps).abort(row);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.content.attachments).toEqual([{ kind: 'coins', count: 120 }]);
  });
});

describe('journal deferStep: a debt that refuses to settle gets loud', () => {
  it('past AUCTION_SETTLEMENT_STUCK_ATTEMPTS the deferral logs at error level, not warn', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rowId = 'auction_settle:' + AID;
    const { deps } = stubDeps({
      cols: { auctionOrders: { updateOne: async () => ({ acknowledged: true }), findOne: rowReads(null) } },
      mail: { async sendSystemMail() { throw new Error('meta 502'); } },
    });
    const row = mkOrder({
      _id: rowId,
      kind: 'settle',
      decided: true,
      attempts: AUCTION_SETTLEMENT_STUCK_ATTEMPTS - 1,
      steps: [{ name: 'seller', op: 'mailCoins', key: rowId + ':seller', accountId: 'seller-1', amount: 180, reason: 'proceeds' }],
    });
    await new AuctionOrderJournal(deps).finalize(row);
    expect(error).toHaveBeenCalledWith('[auctionsvc] settlement step still owed after many retries', expect.objectContaining({ step: 'seller' }));
    expect(warn).not.toHaveBeenCalled();
    error.mockRestore();
    warn.mockRestore();
  });
});

describe('journalSteps.escrow: an itemType nothing knows how to escrow', () => {
  it('is a definitive BAD_REQUEST, so the flow rolls back instead of being retried forever', async () => {
    const { deps } = stubDeps();
    const runner = new AuctionOrderStepRunner(deps);
    await expect(runner.exec({
      name: 'escrow', op: 'escrow', key: 'k', accountId: 'seller-1',
      snapshot: { itemType: 'mystery', item: {}, qty: 1 },
    })).rejects.toThrow(SlgError);
  });
});
