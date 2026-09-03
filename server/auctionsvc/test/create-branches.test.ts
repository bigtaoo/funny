// create.ts branch-coverage gap-fill (2026-09-03 branch-gate pass): 85.7% branches at 98% lines.
//
// httpApi.ts validates the same fields at the HTTP boundary, which is why the e2e suites never send a
// request that reaches these guards — but createAuction is also called with a body assembled by
// httpApi from parsed JSON, and it is the only entry point that ever hands `qty`/`material` to
// meta.deductMaterial or to a mail attachment count. So each refusal here is the real backstop, and
// every one of them was unexecuted. Same for the two equipment-only guardrail arms, which can only be
// reached once meta has answered the escrow.
import { describe, expect, it } from 'vitest';
import {
  AUCTION_DURATIONS_SEC,
  AUCTION_STATIC_REF_PRICE,
  EQUIPMENT_DEFS,
  EQUIP_AUCTION_REF_PRICE_BY_RARITY,
  equipEnhanceExpectedCost,
  SlgError,
  type EquipmentInstance,
} from '@nw/shared';
import { dupKeyError, mkOrder, stubDeps } from './stubDeps';

const DUR = AUCTION_DURATIONS_SEC[0]!;
const base = { sellerId: 'seller-1', durationSec: DUR, qty: 1 } as const;

/** Everything the create flow writes once it gets past validation. */
const writeCols = {
  auctions: {
    countDocuments: async () => 0,
    insertOne: async () => ({ acknowledged: true }),
    deleteOne: async () => ({ acknowledged: true, deletedCount: 1 }),
    updateOne: async () => ({ acknowledged: true }),
  },
  auctionDaily: { findOneAndUpdate: async () => ({ lists: 1 }), updateOne: async () => ({ acknowledged: true }) },
  auctionOrders: {
    insertOne: async () => ({ acknowledged: true }),
    updateOne: async () => ({ acknowledged: true }),
    findOne: async () => null,
  },
  auctionPrices: { findOne: async () => null, updateOne: async () => ({ acknowledged: true }) },
};

async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toThrow(SlgError);
  await expect(p).rejects.toMatchObject({ code });
}

describe('createAuction sale-mode validation', () => {
  it.each([
    ['auction mode with no startPrice', { saleMode: 'auction' as const }],
    ['auction mode with a zero startPrice', { saleMode: 'auction' as const, startPrice: 0 }],
    ['auction mode whose buyout sits below its start price', { saleMode: 'auction' as const, startPrice: 100, buyoutPrice: 99 }],
    ['fixed mode with no price', {}],
    ['fixed mode with a zero price', { price: 0 }],
  ])('%s -> BAD_REQUEST', async (_label, over) => {
    const { svc } = stubDeps();
    await rejects(svc.createAuction({ ...base, itemType: 'material', item: { material: 'scrap' }, ...over }), 'BAD_REQUEST');
  });
});

describe('createAuction payload validation', () => {
  it('a material listing with no `material` key -> BAD_REQUEST', async () => {
    const { svc } = stubDeps();
    await rejects(svc.createAuction({ ...base, itemType: 'material', item: {}, price: 10 }), 'BAD_REQUEST');
  });

  it('a skin listing with no `skinId` -> BAD_REQUEST', async () => {
    const { svc } = stubDeps();
    await rejects(svc.createAuction({ ...base, itemType: 'skin', item: {}, price: 10 }), 'BAD_REQUEST');
  });

  it('an itemType the auction house does not trade -> BAD_REQUEST', async () => {
    const { svc } = stubDeps();
    await rejects(
      svc.createAuction({ ...base, itemType: 'ink' as 'material', item: { material: 'scrap' }, price: 10 }),
      'BAD_REQUEST',
    );
  });
});

describe('createAuction journal collision', () => {
  it('a listing whose freshly-minted key somehow already exists -> REV_CONFLICT, and nothing is escrowed', async () => {
    // The auction id is minted per request, so this cannot collide in practice — the guard exists so a
    // non-`fresh` verdict can never be mistaken for "the key is mine".
    const { svc, mails } = stubDeps({
      cols: {
        auctions: { countDocuments: async () => 0 },
        auctionPrices: { findOne: async () => null },
        auctionOrders: {
          insertOne: async () => { throw dupKeyError(); },
          findOne: async () => mkOrder({ kind: 'list', status: 'done', actorId: 'seller-1' }),
        },
      },
    });
    await rejects(
      svc.createAuction({ ...base, itemType: 'material', item: { material: 'scrap' }, price: AUCTION_STATIC_REF_PRICE['scrap'] }),
      'REV_CONFLICT',
    );
    expect(mails).toEqual([]);
  });
});

describe('createAuction equipment guardrail (only computable after the escrow answers)', () => {
  const rare = EQUIPMENT_DEFS['wp_marker']!;
  const ref = EQUIP_AUCTION_REF_PRICE_BY_RARITY[rare.rarity] + equipEnhanceExpectedCost(0, AUCTION_STATIC_REF_PRICE);
  const instance = { id: 'eq-1', defId: 'wp_marker', level: 0, rarity: rare.rarity, affixes: [] } as unknown as EquipmentInstance;

  it('an auction-mode equipment listing checks its buyoutPrice against the band too, not just the start price', async () => {
    // A buyout above the ceiling would be accepted at listing time and then be permanently
    // un-triggerable, because placeBid applies the guardrail to every amount including a buyout.
    const { svc } = stubDeps({
      cols: writeCols,
      meta: { async escrowEquipment() { return instance; } },
    });
    await rejects(
      svc.createAuction({
        ...base, itemType: 'equipment', item: { instanceId: 'eq-1' },
        saleMode: 'auction', startPrice: ref, buyoutPrice: ref * 100,
      }),
      'PRICE_OUT_OF_RANGE',
    );
  });

  it('a buyout inside the band lists normally', async () => {
    const { svc } = stubDeps({
      cols: writeCols,
      meta: { async escrowEquipment() { return instance; } },
    });
    const view = await svc.createAuction({
      ...base, itemType: 'equipment', item: { instanceId: 'eq-1' },
      saleMode: 'auction', startPrice: ref, buyoutPrice: ref,
    });
    expect(view.buyoutPrice).toBe(ref);
    expect(view.saleMode).toBe('auction');
  });

  it('an escrow that answers without an instance leaves the category unguarded rather than crashing', async () => {
    // `equip:{defId}:{level}` cannot be derived from a payload with no instance in it, and a null
    // category is the guardrail's documented cold-start pass-through.
    const { svc } = stubDeps({
      cols: writeCols,
      meta: { async escrowEquipment() { return undefined as unknown as EquipmentInstance; } },
    });
    const view = await svc.createAuction({ ...base, itemType: 'equipment', item: { instanceId: 'eq-1' }, price: 1 });
    expect(view.itemType).toBe('equipment');
    expect(view.price).toBe(1);
  });
});
