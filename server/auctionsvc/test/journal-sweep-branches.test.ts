// journalSweep.ts branch-coverage gap-fill (2026-09-03 branch-gate pass): the file was at 100% LINES
// and 72.4% branches — the clearest example in the package of why the line metric could not see this.
// The e2e sweep tests drive both passes end to end, so every line runs; what never runs is the
// defensive half of each guard:
//   • the exclusive-claim CAS being LOST (two auctionsvc instances sweeping the same collection —
//     structurally unreachable from a single-process e2e);
//   • a terminal listing whose status the repair pass has no plan for, which must be skipped rather
//     than guessed at;
//   • `kindOf`'s `expired` and legacy-`saleMode` arms;
//   • `rebuild`'s winner/price fallbacks, which decide who a rebuilt settlement pays.
import { describe, expect, it, vi } from 'vitest';
import type { AuctionStatus } from '@nw/shared';
import type { AuctionDoc, AuctionOrderDoc } from '../src/db';
import { mkAuction, mkOrder, NOW, stubDeps } from './stubDeps';

/** A `find(...).limit(n).toArray()` chain answering a fixed batch. */
const batch = <T>(docs: T[]) => ({ find: () => ({ limit: () => ({ toArray: async () => docs }) }) });

/** The journal-row writes a rebuilt-and-driven flow performs. */
const orderWrites = {
  insertOne: async () => ({ acknowledged: true }),
  updateOne: async () => ({ acknowledged: true }),
  findOne: async () => null,
};

/** `repairUnsettled` reads `auctions`; `resumePending` reads `auctionOrders`. Give each pass an empty other half. */
function sweepCols(auctions: AuctionDoc[], orders: AuctionOrderDoc[], extra: Record<string, unknown> = {}) {
  return {
    auctions: { ...batch(auctions), updateOne: async () => ({ acknowledged: true }), ...extra },
    auctionOrders: { ...batch(orders), ...orderWrites },
  };
}

describe('resumePending: the exclusive claim is what keeps two instances off one row', () => {
  it('a row another sweeper claimed since the batch read is skipped, not driven twice', async () => {
    const row = mkOrder({ status: 'pending', claimedAt: NOW - 60_000, decided: true });
    const { svc, mails } = stubDeps({
      cols: {
        auctions: batch<AuctionDoc>([]),
        auctionOrders: { ...batch([row]), ...orderWrites, findOneAndUpdate: async () => null },
      },
    });
    expect(await svc.sweepSettlements()).toEqual({ resumed: 0, repaired: 0 });
    expect(mails).toEqual([]);
  });
});

describe('repairUnsettled: which listings it can rebuild a plan for', () => {
  it('a status it has no plan for is skipped rather than guessed at', async () => {
    // `kindOf` returns null here. Only cancelled / expired / sold can be rebuilt; anything else would
    // mean inventing a hand-over out of a document that never described one.
    const doc = mkAuction({ status: 'frozen' as AuctionStatus });
    const { svc, mails } = stubDeps({ cols: sweepCols([doc], []) });
    expect(await svc.sweepSettlements()).toEqual({ resumed: 0, repaired: 0 });
    expect(mails).toEqual([]);
  });

  it('an expired listing with no settledAt has its return-to-seller plan rebuilt and driven', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const doc = mkAuction({ status: 'expired', closedAt: NOW - 1000 });
    const { svc, mails } = stubDeps({ cols: sweepCols([doc], []) });
    expect(await svc.sweepSettlements()).toEqual({ resumed: 0, repaired: 1 });
    expect(mails).toHaveLength(1);
    expect(mails[0]!.account).toBe('seller-1');
    expect(mails[0]!.content.attachments).toEqual([{ kind: 'material', id: 'scrap', count: 2 }]);
    warn.mockRestore();
  });

  it('a legacy sold listing with no saleMode is a fixed-price buy, whose own row owns the hand-over', async () => {
    // buyAuction journals its intent BEFORE claiming, so a sold fixed-price listing always has a row and
    // belongs to resumePending. Rebuilding one here would be a second driver for the same debt.
    const doc = mkAuction({ status: 'sold', buyerId: 'buyer-1' });
    expect(doc.saleMode).toBeUndefined();
    const { svc, mails } = stubDeps({ cols: sweepCols([doc], []) });
    expect(await svc.sweepSettlements()).toEqual({ resumed: 0, repaired: 0 });
    expect(mails).toEqual([]);
  });

  it('a sold auction with no buyerId settles against the topBid the claim recorded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const doc = mkAuction({
      status: 'sold', saleMode: 'auction', startPrice: 50, qty: 1, price: 50,
      topBid: { bidderId: 'bidder-1', amount: 80, ts: NOW - 500 },
    });
    const { svc, mails } = stubDeps({ cols: sweepCols([doc], []) });
    expect(await svc.sweepSettlements()).toEqual({ resumed: 0, repaired: 1 });
    // Item to the recorded top bidder, post-tax proceeds (80 - 10%) to the seller.
    expect(mails.map((m) => m.account)).toEqual(['bidder-1', 'seller-1']);
    expect(mails[1]!.content.attachments).toEqual([{ kind: 'coins', count: 72 }]);
    warn.mockRestore();
  });

  it('a sold auction with neither buyerId nor topBid falls back to the listing price and an empty winner', async () => {
    // Both fallbacks exist so a rebuilt plan is always well-formed; with no winner the item mail has
    // nobody to go to, but the seller is still paid what the document says the sale was worth.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const doc = mkAuction({ status: 'sold', saleMode: 'auction', qty: 2, price: 100 });
    const { svc, mails } = stubDeps({ cols: sweepCols([doc], []) });
    expect(await svc.sweepSettlements()).toEqual({ resumed: 0, repaired: 1 });
    expect(mails.map((m) => m.account)).toEqual(['', 'seller-1']);
    expect(mails[1]!.content.attachments).toEqual([{ kind: 'coins', count: 180 }]);
    warn.mockRestore();
  });
});
