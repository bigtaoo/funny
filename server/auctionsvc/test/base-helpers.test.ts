// base.ts + delivery.ts branch-coverage gap-fill (2026-09-03 branch-gate pass).
//
// Every helper here is at 100% LINES already: the e2e suites call all of them, but only ever with a
// well-formed listing payload. What was never executed is the other half of each guard — the payload
// whose `instance` / `material` / `skinId` is missing. That shape is not hypothetical: `item` is
// forwarded from httpApi's parsed JSON body verbatim (any key can be absent), and a listing created
// before a payload-shape change keeps whatever it was stored with. These are pure functions plus one
// class with a stubbed mail client, so no Mongo is involved.
import { describe, expect, it } from 'vitest';
import {
  cardInstanceOf,
  categoryOf,
  docToAdminView,
  docToView,
  equipInstanceOf,
  itemNameOf,
} from '../src/auctionService/base';
import { AuctionServiceDelivery } from '../src/auctionService/delivery';
import type { AuctionItemSnapshot } from '../src/db';
import { mkAuction, stubDeps } from './stubDeps';

describe('equipInstanceOf / cardInstanceOf: payload without an `instance`', () => {
  it('returns null for an absent instance key', () => {
    expect(equipInstanceOf({})).toBeNull();
    expect(cardInstanceOf({})).toBeNull();
  });

  it('returns null for a non-object instance (a bare id string, the shape a create request sends)', () => {
    expect(equipInstanceOf({ instance: 'eq-1' })).toBeNull();
    expect(cardInstanceOf({ instance: 42 })).toBeNull();
  });
});

describe('categoryOf: unguarded payloads fall through to null (cold-start pass-through)', () => {
  it('material listing with no `material` key -> null, so checkPriceGuard passes it through', () => {
    expect(categoryOf({ itemType: 'material', item: {} })).toBeNull();
  });

  it('equipment listing whose instance snapshot is missing -> null', () => {
    expect(categoryOf({ itemType: 'equipment', item: { instanceId: 'eq-1' } })).toBeNull();
  });

  it('equipment instance with no defId -> null (never bucketed as `equip:undefined:0`)', () => {
    expect(categoryOf({ itemType: 'equipment', item: { instance: { level: 3 } } })).toBeNull();
  });

  it('a well-formed equipment instance still buckets by defId+level', () => {
    expect(categoryOf({ itemType: 'equipment', item: { instance: { defId: 'wp_marker', level: 3 } } })).toBe('equip:wp_marker:3');
  });
});

describe('itemNameOf: the ops display name is "" rather than undefined for every malformed payload', () => {
  it.each([
    ['material', {}],
    ['equipment', { instanceId: 'eq-1' }],
    ['card', { instanceId: 'cd-1' }],
    ['skin', {}],
  ] as const)('%s with nothing derivable -> empty string', (itemType, item) => {
    expect(itemNameOf({ itemType, item })).toBe('');
  });

  it('an unknown itemType also yields "" (the fallthrough, not a crash)', () => {
    expect(itemNameOf({ itemType: 'mystery', item: { material: 'scrap' } })).toBe('');
  });

  it('docToAdminView carries that empty name through instead of omitting the field', () => {
    const view = docToAdminView(mkAuction({ itemType: 'skin', item: {} }));
    expect(view.itemName).toBe('');
  });
});

describe('docToView: an auction-mode listing with neither topBid nor startPrice', () => {
  it('falls back to `price` for the effective unit price', () => {
    const view = docToView(mkAuction({ saleMode: 'auction', price: 70, qty: 3 }));
    expect(view.price).toBe(70);
    expect(view.totalPrice).toBe(210);
    expect(view.startPrice).toBeUndefined();
    expect(view.topBid).toBeUndefined();
  });

  it('prefers startPrice over price when only startPrice is set', () => {
    const view = docToView(mkAuction({ saleMode: 'auction', price: 70, startPrice: 55, qty: 2 }));
    expect(view.price).toBe(55);
    expect(view.totalPrice).toBe(110);
  });
});

describe('delivery: a malformed snapshot is a completed hand-over, not a retryable failure', () => {
  const snapshot = (over: Partial<AuctionItemSnapshot>): AuctionItemSnapshot =>
    ({ itemType: 'material', item: {}, qty: 1, ...over });

  it.each([
    ['equipment with no instance', snapshot({ itemType: 'equipment', item: { instanceId: 'eq-1' } })],
    ['card with no instance', snapshot({ itemType: 'card', item: { instanceId: 'cd-1' } })],
    ['skin with no skinId', snapshot({ itemType: 'skin', item: {} })],
    ['an itemType nothing knows how to attach', snapshot({ itemType: 'mystery', item: {} })],
  ])('deliverItem sends no mail for %s (retrying cannot conjure an instance)', async (_label, snap) => {
    const { deps, mails } = stubDeps();
    await new AuctionServiceDelivery(deps).deliverItem('acc-1', snap, 'dk-1', 'returned');
    expect(mails).toEqual([]);
  });

  it('a well-formed skin snapshot does mail (the guard is not blanket-skipping skins)', async () => {
    const { deps, mails } = stubDeps();
    await new AuctionServiceDelivery(deps).deliverItem('acc-1', snapshot({ itemType: 'skin', item: { skinId: 'sk_ink' } }), 'dk-2', 'sold');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.content.attachments).toEqual([{ kind: 'skin', id: 'sk_ink' }]);
  });

  it.each([0, -50])('deliverCoins(%i) sends no mail — an empty coin mail is worse than none', async (amount) => {
    const { deps, mails } = stubDeps();
    await new AuctionServiceDelivery(deps).deliverCoins('acc-1', amount, 'dk-3', 'refund');
    expect(mails).toEqual([]);
  });
});
