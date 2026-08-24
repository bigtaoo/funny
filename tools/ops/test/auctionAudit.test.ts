// src/logic/auctionAudit.ts — anti-RMT: the bounded-query rule, the price column's three-way choice,
// and the snapshot a filed ticket freezes.
import { describe, expect, it } from 'vitest';
import {
  anomaliesFoundText, auditResolvedByText, auditTicketFiledBy, auditTicketStatusCls, canAdjudicate,
  completedText, enforcementText, listingCloseTs, listingItemText, listingPriceLabel, listingQuery,
  listingSettlementCls, listingSettlementState, listingSettlementText, listingsFoundText,
  listingStatusCls, noAnomaliesText, noSettlementsText, owedStepText, owedSummary, resolvePrompt,
  scanWindowSec, sellerBuyerText, settlementAttemptsText, settlementCycleText, settlementPhaseText,
  settlementQuery, settlementRowCls, settlementsFoundText, settlementTimingText, severityCls, snapshotOf,
} from '../src/logic/auctionAudit';
import type {
  AuctionAnomaly, AuctionListingAdminView, AuctionSettlementDebtView, AuctionSettlementStepView,
  TradeAuditTicketView,
} from '../src/types';

const stamp = (ms: number): string => `T${ms}`;
const blank = { sellerId: '', itemType: '', status: '', itemName: '' };

const listing = (over: Partial<AuctionListingAdminView> = {}): AuctionListingAdminView => ({
  auctionId: 'a-1', sellerId: 'acc-1', itemType: 'material', itemName: 'ink_blue', qty: 3,
  price: 100, saleMode: 'fixed', status: 'open', expireAt: 500, ...over,
} as AuctionListingAdminView);

describe('listingQuery', () => {
  it('refuses an unbounded query', () => {
    expect(listingQuery(blank)).toEqual({
      ok: false, error: 'at least one of sellerId / itemType / item name is required',
    });
  });

  it('refuses a status-only query — "every expired listing ever" is the same unbounded query', () => {
    expect(listingQuery({ ...blank, status: 'expired' })).toMatchObject({ ok: false });
  });

  it('accepts any one of seller / item type / item name', () => {
    expect(listingQuery({ ...blank, sellerId: 'acc-1' })).toEqual({ ok: true, filter: { sellerId: 'acc-1' } });
    expect(listingQuery({ ...blank, itemType: 'card' })).toEqual({ ok: true, filter: { itemType: 'card' } });
    expect(listingQuery({ ...blank, itemName: 'ink' })).toEqual({ ok: true, filter: { itemName: 'ink' } });
  });

  it('trims the free-text fields and treats whitespace as blank', () => {
    expect(listingQuery({ ...blank, sellerId: '  acc-1  ' })).toEqual({ ok: true, filter: { sellerId: 'acc-1' } });
    expect(listingQuery({ ...blank, sellerId: '   ' })).toMatchObject({ ok: false });
  });

  it('carries the status through once the query is bounded', () => {
    expect(listingQuery({ sellerId: 'acc-1', itemType: 'skin', status: 'sold', itemName: 'ink' })).toEqual({
      ok: true, filter: { sellerId: 'acc-1', itemType: 'skin', status: 'sold', itemName: 'ink' },
    });
  });
});

describe('listing row', () => {
  it('colours the four statuses, and leaves an unknown one unstyled', () => {
    expect(listingStatusCls('open')).toBe('warn');
    expect(listingStatusCls('expired')).toBe('failed');
    expect(listingStatusCls('sold')).toBe('');
    expect(listingStatusCls('cancelled')).toBe('');
    expect(listingStatusCls('frozen')).toBe('');
  });

  it('shows a fixed-price listing’s single price', () => {
    expect(listingPriceLabel(listing())).toBe('100');
  });

  it('shows an auction’s start price until someone bids, then the bid', () => {
    const auction = listing({ saleMode: 'auction', startPrice: 50 });
    expect(listingPriceLabel(auction)).toBe('start 50');
    expect(listingPriceLabel({ ...auction, topBid: { amount: 75, bidderId: 'b' } } as AuctionListingAdminView)).toBe('bid 75');
  });

  it('falls back to `price` when an auction carries no explicit start price', () => {
    expect(listingPriceLabel(listing({ saleMode: 'auction' }))).toBe('start 100');
  });

  it('appends the buyout when there is one', () => {
    const auction = listing({ saleMode: 'auction', startPrice: 50, buyoutPrice: 500 });
    expect(listingPriceLabel(auction)).toBe('start 50 / buyout 500');
    expect(listingPriceLabel({ ...auction, buyoutPrice: 0 })).toBe('start 50 / buyout 0');
  });

  it('prefers the sale time, then the close time, then the expiry', () => {
    expect(listingCloseTs(listing())).toBe(500);
    expect(listingCloseTs(listing({ closedAt: 300 }))).toBe(300);
    expect(listingCloseTs(listing({ closedAt: 300, soldAt: 200 }))).toBe(200);
  });

  it('describes the item as type plus name, dashing an empty name', () => {
    expect(listingItemText({ itemType: 'material', itemName: 'ink_blue' })).toBe('material: ink_blue');
    expect(listingItemText({ itemType: 'equipment', itemName: '' })).toBe('equipment: —');
  });

  it('counts hits', () => {
    expect(listingsFoundText(1)).toBe('1 listing found');
    expect(listingsFoundText(0)).toBe('0 listings found');
  });
});

describe('anomaly scan', () => {
  it('leaves the window to the backend when the field is blank', () => {
    expect(scanWindowSec('')).toBeUndefined();
    expect(scanWindowSec('   ')).toBeUndefined();
  });

  it('passes an explicit window through, including 0 (which is NOT the same as blank)', () => {
    expect(scanWindowSec(' 7200 ')).toBe(7200);
    expect(scanWindowSec('0')).toBe(0);
  });

  it('colours severities, treating an unclassified one as a warning rather than nothing', () => {
    expect(severityCls('high')).toBe('failed');
    expect(severityCls('medium')).toBe('warn');
    expect(severityCls('low')).toBe('warn');
  });

  it('names the world in both the found and the empty message', () => {
    expect(anomaliesFoundText(1, 's1-0')).toBe('1 suspicious pair found in world "s1-0"');
    expect(anomaliesFoundText(4, 's1-0')).toBe('4 suspicious pairs found in world "s1-0"');
    expect(noAnomaliesText('s1-0')).toBe('No anomalies found in world "s1-0".');
  });
});

describe('snapshotOf', () => {
  const anomaly: AuctionAnomaly = {
    sellerId: 'acc-1', buyerId: 'acc-2', trades: 6, designatedTrades: 6, totalCoins: 90000,
    firstTs: 10, lastTs: 20, severity: 'high', reasons: ['designated', 'high_value'],
  };

  it('freezes every scan field plus the world it came from', () => {
    expect(snapshotOf(anomaly, 's1-0')).toEqual({ worldId: 's1-0', ...anomaly });
  });

  it('carries the reasons list through unchanged', () => {
    expect(snapshotOf(anomaly, 's1-0').reasons).toEqual(['designated', 'high_value']);
  });
});

describe('audit ticket row', () => {
  const ticket = (over: Partial<TradeAuditTicketView> = {}): TradeAuditTicketView => ({
    id: 'tk-1', status: 'open', filedAt: 1, filedBy: 'adm-0123456789',
    snapshot: {
      worldId: 's1-0', sellerId: 'acc-1', buyerId: 'acc-2', trades: 6, designatedTrades: 6,
      totalCoins: 90000, firstTs: 10, lastTs: 20, severity: 'high', reasons: ['designated'],
    },
    ...over,
  } as TradeAuditTicketView);

  it('colours the three ticket statuses', () => {
    expect(auditTicketStatusCls('open')).toBe('warn');
    expect(auditTicketStatusCls('actioned')).toBe('failed');
    expect(auditTicketStatusCls('dismissed')).toBe('');
    expect(auditTicketStatusCls('reopened')).toBe('');
  });

  it('names the filer, shortening a bare id', () => {
    expect(auditTicketFiledBy(ticket())).toBe('adm-0123');
    expect(auditTicketFiledBy(ticket({ filedByName: 'Ada' }))).toBe('Ada');
  });

  it('reads the trade direction', () => {
    expect(sellerBuyerText({ sellerId: 'acc-1', buyerId: 'acc-2' })).toBe('acc-1 → acc-2');
  });

  it('only adjudicates an open ticket, and only with slg.audit.manage', () => {
    expect(canAdjudicate(true, 'open')).toBe(true);
    expect(canAdjudicate(false, 'open')).toBe(false);
    expect(canAdjudicate(true, 'actioned')).toBe(false);
  });

  it('names the verdict in the note prompt so a misclick is visible', () => {
    expect(resolvePrompt('actioned')).toBe('Confirmed violation: add a note (optional)');
    expect(resolvePrompt('dismissed')).toBe('Dismiss: add a note (optional)');
  });

  it('attributes a resolution, with the time when it has one', () => {
    expect(auditResolvedByText(ticket({ status: 'dismissed', resolvedByName: 'Ada', resolvedAt: 42 }), stamp))
      .toBe('by Ada · T42');
    expect(auditResolvedByText(ticket({ status: 'dismissed', resolvedBy: 'adm-0123456789' }), stamp))
      .toBe('by adm-0123');
    expect(auditResolvedByText(ticket({ status: 'dismissed' }), stamp)).toBe('by —');
  });

  it('reports each party’s ban outcome — "ban failed" is the case that matters', () => {
    expect(enforcementText({ sellerBanned: true, buyerBanned: true })).toBe('Enforcement: seller banned, buyer banned');
    expect(enforcementText({ sellerBanned: true, buyerBanned: false })).toBe('Enforcement: seller banned, buyer ban failed');
    expect(enforcementText({ sellerBanned: false, buyerBanned: false })).toBe('Enforcement: seller ban failed, buyer ban failed');
  });
});

// ── Owed settlements (U13 close-out) ──

const debt = (over: Partial<AuctionSettlementDebtView> = {}): AuctionSettlementDebtView => ({
  orderId: 'auction_buy:a-1:acc-2', auctionId: 'a-1', kind: 'buy', actorId: 'acc-2',
  phase: 'forward', owed: [], completed: [], attempts: 1, stuck: false, cycle: 0,
  createdAt: 1000, nextAttemptAt: 5000, ...over,
});

const step = (over: Partial<AuctionSettlementStepView> = {}): AuctionSettlementStepView => ({
  name: 'seller', op: 'mailCoins', key: 'auction_buy:a-1:acc-2:seller', ...over,
});

describe('listingSettlementState', () => {
  it('separates "nothing to settle yet" from "settled" from "still owed"', () => {
    // The three-way split is the whole point: an OPEN listing has no hand-over due, so treating a missing
    // settledAt as a debt there would paint the entire live market as broken.
    expect(listingSettlementState(listing({ status: 'open' }))).toBe('open');
    expect(listingSettlementState(listing({ status: 'sold', settledAt: 900 }))).toBe('settled');
    expect(listingSettlementState(listing({ status: 'sold' }))).toBe('owed');
  });

  it('treats every closed status the same way — cancelled and expired owe the seller their item back', () => {
    expect(listingSettlementState(listing({ status: 'cancelled' }))).toBe('owed');
    expect(listingSettlementState(listing({ status: 'expired' }))).toBe('owed');
    expect(listingSettlementState(listing({ status: 'expired', settledAt: 1 }))).toBe('settled');
  });

  it('reads a settledAt of 0 as settled, not as absent', () => {
    // Epoch-0 is not a real timestamp, but `settledAt != null` vs a truthiness check is exactly the sort of
    // slip that would silently reclassify a settled listing as a debt.
    expect(listingSettlementState(listing({ status: 'sold', settledAt: 0 }))).toBe('settled');
  });

  it('labels and colours only the owed case', () => {
    expect(listingSettlementText(listing({ status: 'open' }))).toBe('—');
    expect(listingSettlementText(listing({ status: 'sold', settledAt: 9 }))).toBe('settled');
    expect(listingSettlementText(listing({ status: 'sold' }))).toBe('OWED');
    expect(listingSettlementCls(listing({ status: 'sold' }))).toBe('failed');
    expect(listingSettlementCls(listing({ status: 'sold', settledAt: 9 }))).toBe('');
    expect(listingSettlementCls(listing({ status: 'open' }))).toBe('');
  });
});

describe('settlementQuery', () => {
  const blankOwed = { auctionId: '', accountId: '', minAttempts: '' };

  it('allows the fully unfiltered query — "show me everything still owed" is the useful one here', () => {
    // Deliberately the opposite rule from listingQuery: the unfinished set is tiny by nature, so an
    // unbounded query is cheap AND is the question ops actually asks.
    expect(settlementQuery(blankOwed)).toEqual({ ok: true, filter: {} });
  });

  it('trims the free-text fields and treats whitespace as blank', () => {
    expect(settlementQuery({ ...blankOwed, auctionId: '  a-1 ', accountId: ' acc-2 ' }))
      .toEqual({ ok: true, filter: { auctionId: 'a-1', accountId: 'acc-2' } });
    expect(settlementQuery({ ...blankOwed, auctionId: '   ' })).toEqual({ ok: true, filter: {} });
  });

  it('accepts a min-attempts threshold, including an explicit zero', () => {
    expect(settlementQuery({ ...blankOwed, minAttempts: '10' })).toEqual({ ok: true, filter: { minAttempts: 10 } });
    expect(settlementQuery({ ...blankOwed, minAttempts: '0' })).toEqual({ ok: true, filter: { minAttempts: 0 } });
  });

  it('rejects a min-attempts that is not a non-negative integer', () => {
    for (const bad of ['-1', '1.5', 'abc', '1e3x']) {
      expect(settlementQuery({ ...blankOwed, minAttempts: bad }), bad)
        .toEqual({ ok: false, error: 'min attempts must be a non-negative integer' });
    }
  });
});

describe('owed-settlement labels', () => {
  it('distinguishes "nothing owed" from "the filter matched nothing"', () => {
    // A blank table is the normal state here, so the two readings have to be told apart in words —
    // otherwise a too-narrow filter reads as an all-clear.
    expect(noSettlementsText(false)).toBe('Nothing owed — every settlement has handed over.');
    expect(noSettlementsText(true)).toBe('No unfinished settlements match this filter.');
  });

  it('counts unfinished settlements with a plural', () => {
    expect(settlementsFoundText(1)).toBe('1 unfinished settlement found');
    expect(settlementsFoundText(3)).toBe('3 unfinished settlements found');
  });

  it('marks only a stuck row as failed — everything else is mid-backoff and self-resolving', () => {
    expect(settlementRowCls(debt({ stuck: true }))).toBe('failed');
    expect(settlementRowCls(debt({ stuck: false }))).toBe('warn');
    expect(settlementAttemptsText(debt({ attempts: 14, stuck: true }))).toBe('14 (stuck)');
    expect(settlementAttemptsText(debt({ attempts: 2, stuck: false }))).toBe('2');
  });

  it('says what the settlement is doing in words, not field names', () => {
    expect(settlementPhaseText(debt({ kind: 'buy', phase: 'forward' }))).toBe('buy · delivering');
    expect(settlementPhaseText(debt({ kind: 'bid', phase: 'rollback' }))).toBe('bid · unwinding');
    expect(settlementPhaseText(debt({ kind: 'settle', phase: 'forward' }))).toBe('settle · delivering');
  });

  it('only mentions the cycle when the settlement has actually been reopened', () => {
    expect(settlementCycleText(debt({ cycle: 0 }))).toBe('');
    expect(settlementCycleText(debt({ cycle: 2 }))).toBe('retry #2');
  });

  it('lists what already landed, and says so plainly when nothing has', () => {
    expect(completedText(debt({ completed: [] }))).toBe('nothing yet');
    expect(completedText(debt({ completed: ['spend', 'item'] }))).toBe('spend, item');
  });

  it('reports both how long it has been owed and when the sweep will retry', () => {
    // The "next try" half is what stops a reader concluding the row is abandoned — it is not, the sweep
    // is just backing off.
    expect(settlementTimingText(debt({ createdAt: 10, nextAttemptAt: 99 }), stamp)).toBe('since T10 · next try T99');
  });
});

describe('owedStepText', () => {
  it('names the coin amount for a payment', () => {
    expect(owedStepText(step({ name: 'seller', accountId: 'acc-1', amount: 270 })))
      .toBe('seller: acc-1 ← 270 coins');
  });

  it('names the item for a delivery', () => {
    expect(owedStepText(step({ name: 'item', op: 'mailItem', accountId: 'acc-2', item: 'equipment wp_marker' })))
      .toBe('item: acc-2 ← equipment wp_marker');
  });

  it('prefers the coin amount when a step somehow carries both', () => {
    expect(owedStepText(step({ accountId: 'acc-1', amount: 5, item: 'material scrap' })))
      .toBe('seller: acc-1 ← 5 coins');
  });

  it('falls back to the op name when a step carries neither', () => {
    expect(owedStepText(step({ name: 'escrow', op: 'escrow', accountId: 'acc-1' })))
      .toBe('escrow: acc-1 ← escrow');
  });

  it('says "internal" for a local step rather than naming a phantom account', () => {
    // `unclaim` releases a listing this service claimed; nobody downstream is owed anything by it.
    expect(owedStepText(step({ name: 'unclaim', op: 'unclaim' }))).toBe('unclaim: unclaim (internal)');
  });

  it('reads a zero amount as an amount, not as absent', () => {
    expect(owedStepText(step({ accountId: 'acc-1', amount: 0 }))).toBe('seller: acc-1 ← 0 coins');
  });
});

describe('owedSummary', () => {
  it('joins every owed step, so one row shows the whole debt', () => {
    expect(owedSummary(debt({
      owed: [
        step({ name: 'item', op: 'mailItem', accountId: 'acc-2', item: 'material scrap x3' }),
        step({ name: 'seller', accountId: 'acc-1', amount: 27 }),
      ],
    }))).toBe('item: acc-2 ← material scrap x3; seller: acc-1 ← 27 coins');
  });

  it('renders an empty debt as a dash rather than a blank cell', () => {
    expect(owedSummary(debt({ owed: [] }))).toBe('—');
  });
});
