// auctionsvc AuctionService split — create listing (see ../auctionService.ts).
//
// Independent sibling class (2026-08-11 re-audit, converted from a linear inheritance chain to
// composition): depends on AuctionServicePricing (checkPriceGuard/bumpDaily) and, since the 2026-08-24
// U13 close-out, on AuctionOrderJournal for the escrow itself.
//
// What the journal changed here: the escrow → insert window is now recorded, so a crash between "the item
// left the seller's inventory" and "the listing exists" hands the item back instead of destroying it. The
// old inline try/catch rollbacks only ever fired on a thrown business error — a process death in that
// window silently ate the seller's equipment, and an escrow that timed out (rather than being refused) was
// rolled back on a guess, which could just as easily duplicate the item.
import { AUCTION_DURATIONS_SEC, AUCTION_MAX_LISTINGS, AUCTION_DAILY_LIST_CAP, AUCTION_BANNED_MATERIALS, SlgError } from '@nw/shared';
import type { AuctionDoc } from '../db';
import type { AuctionServiceDeps } from './base';
import { docToView, makeAuctionId, nextAuctionSeq, categoryOf, equipInstanceOf, type AuctionView } from './base';
import type { AuctionServicePricing } from './pricing';
import type { AuctionOrderJournal } from './journal';
import { flowKey, planForList } from './journalPlans';

export class AuctionServiceCreate {
  constructor(
    private readonly deps: AuctionServiceDeps,
    private readonly pricing: AuctionServicePricing,
    private readonly journal: AuctionOrderJournal,
  ) {}

  /**
   * Create a listing.
   * itemType='material' → deducts materials from meta (orderId-idempotent).
   * itemType='equipment' → meta.escrowEquipment holds the instance in escrow (equipped/locked/not found → SlgError).
   * itemType='card' → meta.escrowCard holds the instance in escrow (gear not empty/not found → SlgError).
   * itemType='skin' → meta.escrowSkin holds the skin in escrow (equipped/not owned → SlgError).
   * saleMode='fixed' (default): price = buyout unit price.
   * saleMode='auction': startPrice = starting unit price, buyoutPrice? = optional buyout floor unit price.
   * durationSec must be one of AUCTION_DURATIONS_SEC; open listings per account ≤ AUCTION_MAX_LISTINGS;
   * daily new listings ≤ AUCTION_DAILY_LIST_CAP (C); banned materials rejected (E); unit price out of range rejected (G).
   */
  async createAuction(params: {
    sellerId: string;
    itemType: 'material' | 'equipment' | 'card' | 'skin';
    item: Record<string, unknown>;
    qty: number;
    price?: number; // fixed mode: buyout unit price
    saleMode?: 'fixed' | 'auction';
    startPrice?: number; // auction mode: start unit price
    buyoutPrice?: number; // auction mode: buyout floor unit price (optional)
    durationSec: number;
    designatedBuyerId?: string;
  }): Promise<AuctionView> {
    const { sellerId, itemType, item, qty, durationSec, designatedBuyerId } = params;
    const saleMode = params.saleMode ?? 'fixed';
    const { cols, now } = this.deps;

    if (!AUCTION_DURATIONS_SEC.includes(durationSec)) throw new SlgError('BAD_REQUEST');
    // Equipment, card and skin qty is always 1 (non-stackable unique instances); material qty must be a
    // positive integer (httpApi.ts already checks this at the HTTP boundary; re-checked here since this
    // is the only entry point that ever reaches meta.deductMaterial/mail-attachment count with `qty`, and
    // those don't validate it themselves — a fractional value here would flow straight into an integer
    // material count).
    const effectiveQty = (itemType === 'equipment' || itemType === 'card' || itemType === 'skin') ? 1 : qty;
    if (!Number.isInteger(effectiveQty) || effectiveQty <= 0) throw new SlgError('BAD_REQUEST');

    // Validate sale mode parameters and determine listing unit price (used for browse sorting + guardrail check)
    let unitPrice: number; // buyout unit price / auction start unit price
    let startPrice: number | undefined;
    let buyoutPrice: number | undefined;
    if (saleMode === 'auction') {
      startPrice = params.startPrice;
      buyoutPrice = params.buyoutPrice;
      if (startPrice == null || startPrice <= 0) throw new SlgError('BAD_REQUEST');
      if (buyoutPrice != null && buyoutPrice < startPrice) throw new SlgError('BAD_REQUEST');
      unitPrice = startPrice;
    } else {
      if (params.price == null || params.price <= 0) throw new SlgError('BAD_REQUEST');
      unitPrice = params.price;
    }

    // ── Pre-escrow validation: everything decidable without touching the seller's inventory ──
    if (itemType === 'material') {
      // E Bound-material block
      const material = item['material'] as string | undefined;
      if (!material) throw new SlgError('BAD_REQUEST');
      if (AUCTION_BANNED_MATERIALS.has(material)) throw new SlgError('MATERIAL_NOT_TRADEABLE');
      // G Price guardrail (validate unit price against category reference price). For auction-mode
      // listings, buyoutPrice must ALSO be within the guardrail band at listing time — placeBid's
      // guardrail check applies unconditionally to every bid amount including a buyout, so a buyout price
      // above the ceiling would otherwise be accepted here but then be permanently un-triggerable at bid
      // time (PRICE_OUT_OF_RANGE), silently making the seller's configured buyout unusable.
      const category = categoryOf({ itemType, item });
      await this.pricing.checkPriceGuard(category, unitPrice);
      if (buyoutPrice != null) await this.pricing.checkPriceGuard(category, buyoutPrice);
    } else if (itemType === 'equipment' || itemType === 'card') {
      if (typeof item['instanceId'] !== 'string') throw new SlgError('BAD_REQUEST');
    } else if (itemType === 'skin') {
      if (typeof item['skinId'] !== 'string') throw new SlgError('BAD_REQUEST');
    } else {
      throw new SlgError('BAD_REQUEST');
    }
    // Concurrent listing count cap (fast-fail only; the authoritative recount is after the insert below).
    const openCount = await cols.auctions.countDocuments({ sellerId, status: 'open' });
    if (openCount >= AUCTION_MAX_LISTINGS) throw new SlgError('AUCTION_LIMIT_REACHED');

    const ts = now();
    const aid = makeAuctionId(sellerId, ts, nextAuctionSeq());
    const rowId = flowKey('list', aid);
    const requested = { itemType, item, qty: effectiveQty };

    // The auction id is freshly minted per request, so this key cannot collide — `begin` is here for the
    // durable record of the escrow, not for dedupe.
    const begun = await this.journal.begin(rowId, 'list', aid, sellerId, (cycle) => planForList(rowId, cycle, sellerId, requested));
    if (begun.state !== 'fresh') throw new SlgError('REV_CONFLICT', 'Listing is already being created, please retry');
    const row = begun.row;

    // Escrow: removes the item from the seller. Equipped/locked/gear-not-empty/not-found → meta throws an
    // SlgError, which is definitive, so the journal rolls the flow back with nothing to hand back.
    try {
      await this.journal.advance(row);
    } catch (e) {
      await this.journal.abort(row);
      throw e;
    }
    if (row.done['escrow'] == null) {
      // Indeterminate escrow: the sweep resolves it against meta's own orderId idempotency and, since the
      // listing was never created, hands the item back. Guessing here is what would duplicate it.
      throw new SlgError('REV_CONFLICT', 'Listing is still being confirmed, please retry');
    }
    // Material escrow has nothing to resolve (the payload is already complete); the others come back as
    // the full instance snapshot the listing stores.
    const storedItem = row.escrowed?.item ?? item;

    try {
      if (itemType === 'equipment') {
        // G Price guardrail (equipment by defId/level category) — only computable once the instance is known.
        // See the material branch above for why buyoutPrice needs the same check as unitPrice.
        const inst = equipInstanceOf(storedItem);
        const category = inst ? `equip:${inst.defId}:${inst.level}` : null;
        await this.pricing.checkPriceGuard(category, unitPrice);
        if (buyoutPrice != null) await this.pricing.checkPriceGuard(category, buyoutPrice);
      }
      // C Daily new-listing cap (reserve slot). Deliberately after the escrow for every itemType: a cap
      // rejection now costs the seller nothing, whereas reserving first burned a slot whenever the escrow
      // then failed.
      await this.pricing.bumpDaily(sellerId, 'lists', AUCTION_DAILY_LIST_CAP);
    } catch (e) {
      await this.journal.abort(row); // hands the escrowed item straight back (op 'grant', requires 'escrow')
      throw e;
    }

    const doc: AuctionDoc = {
      _id: aid,
      sellerId,
      itemType,
      item: storedItem,
      qty: effectiveQty,
      price: unitPrice,
      currency: 'coins',
      ...(designatedBuyerId ? { designatedBuyerId } : {}),
      expireAt: ts + durationSec * 1000,
      status: 'open',
      saleMode,
      ...(startPrice != null ? { startPrice } : {}),
      ...(buyoutPrice != null ? { buyoutPrice } : {}),
      rev: 1,
    };
    await cols.auctions.insertOne(doc);

    // Authoritative cap enforcement: the `openCount` check above is only a fast-fail optimization against a
    // stale read — it runs before this insert, so concurrent createAuction calls from the same seller can
    // all pass it before any of them has inserted. This recount reflects the true persisted state right
    // after the insert, so no race window can leave a seller above the cap. Its only imperfection: under a
    // genuine simultaneous race, more than one concurrent request may be told to retry even though a slot
    // was available for one of them — safety holds (the cap is never exceeded), and a retry immediately
    // succeeds once the field self-corrects.
    const finalOpenCount = await cols.auctions.countDocuments({ sellerId, status: 'open' });
    if (finalOpenCount > AUCTION_MAX_LISTINGS) {
      await cols.auctions.deleteOne({ _id: aid });
      await this.journal.abort(row);
      throw new SlgError('AUCTION_LIMIT_REACHED');
    }

    // The listing exists: nothing is owed any more, so close the row out.
    await this.journal.decide(row);
    await this.journal.finalize(row);

    return docToView(doc);
  }
}
