// src/logic/auctionAudit.ts — anti-RMT: the bounded-query rule, the price column's three-way choice,
// and the snapshot a filed ticket freezes.
import { describe, expect, it } from 'vitest';
import {
  anomaliesFoundText, auditResolvedByText, auditTicketFiledBy, auditTicketStatusCls, canAdjudicate,
  enforcementText, listingCloseTs, listingItemText, listingPriceLabel, listingQuery,
  listingsFoundText, listingStatusCls, noAnomaliesText, resolvePrompt, scanWindowSec, sellerBuyerText,
  severityCls, snapshotOf,
} from '../src/logic/auctionAudit';
import type { AuctionAnomaly, AuctionListingAdminView, TradeAuditTicketView } from '../src/types';

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
