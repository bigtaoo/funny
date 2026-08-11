// auctionsvc AuctionService split — create listing (see ../auctionService.ts).
//
// Independent sibling class (2026-08-11 re-audit, converted from a linear inheritance chain to
// composition): depends on AuctionServicePricing (checkPriceGuard/bumpDaily) — the only cross-layer
// edge in this file, injected via the constructor instead of inherited.
import { AUCTION_DURATIONS_SEC, AUCTION_MAX_LISTINGS, AUCTION_DAILY_LIST_CAP, AUCTION_BANNED_MATERIALS, SlgError } from '@nw/shared';
import type { AuctionDoc } from '../db';
import type { AuctionServiceDeps } from './base';
import { docToView, makeAuctionId, nextAuctionSeq, categoryOf, equipInstanceOf, cardInstanceOf, type AuctionView } from './base';
import type { AuctionServicePricing } from './pricing';

export class AuctionServiceCreate {
  constructor(
    private readonly deps: AuctionServiceDeps,
    private readonly pricing: AuctionServicePricing,
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
    const { cols, now, meta } = this.deps;

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

    const ts = now();
    const seq = nextAuctionSeq();
    const aid = makeAuctionId(sellerId, ts, seq);
    const orderId = `auction_list:${aid}`;
    let storedItem: Record<string, unknown> = item;

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
      await this.pricing.checkPriceGuard(categoryOf({ itemType, item }), unitPrice);
      if (buyoutPrice != null) await this.pricing.checkPriceGuard(categoryOf({ itemType, item }), buyoutPrice);
      // Concurrent listing count cap
      const openCount = await cols.auctions.countDocuments({ sellerId, status: 'open' });
      if (openCount >= AUCTION_MAX_LISTINGS) throw new SlgError('AUCTION_LIMIT_REACHED');
      // C Daily new-listing cap (reserve slot)
      await this.pricing.bumpDaily(sellerId, 'lists', AUCTION_DAILY_LIST_CAP);
      // Deduct material from meta (escrow)
      await meta.deductMaterial(sellerId, material, qty, orderId);
    } else if (itemType === 'equipment') {
      // A Equipment trade: client sends instanceId; server escrows the full instance (removes from seller inventory) → stores snapshot.
      const instanceId = item['instanceId'];
      if (typeof instanceId !== 'string') throw new SlgError('BAD_REQUEST');
      const openCount = await cols.auctions.countDocuments({ sellerId, status: 'open' });
      if (openCount >= AUCTION_MAX_LISTINGS) throw new SlgError('AUCTION_LIMIT_REACHED');
      // Escrow: equipped/locked/not-found causes meta to throw SlgError (EQUIP_IN_USE/EQUIP_LOCKED/EQUIP_NOT_FOUND).
      const instance = await meta.escrowEquipment(sellerId, instanceId, orderId);
      storedItem = { instance };
      try {
        // G Price guardrail (equipment by defId/rarity/level category) + C daily cap — return escrowed instance on failure.
        // See the material branch above for why buyoutPrice needs the same guardrail check as unitPrice.
        await this.pricing.checkPriceGuard(`equip:${instance.defId}:${instance.level}`, unitPrice);
        if (buyoutPrice != null) await this.pricing.checkPriceGuard(`equip:${instance.defId}:${instance.level}`, buyoutPrice);
        await this.pricing.bumpDaily(sellerId, 'lists', AUCTION_DAILY_LIST_CAP);
      } catch (e) {
        await meta.grantEquipment(sellerId, instance, `${orderId}:return`);
        throw e;
      }
    } else if (itemType === 'card') {
      // CC-5 Card trade: client sends instanceId; server escrows the full instance (validates gear all empty, removes from cardInv) → stores snapshot.
      const instanceId = item['instanceId'];
      if (typeof instanceId !== 'string') throw new SlgError('BAD_REQUEST');
      const openCount = await cols.auctions.countDocuments({ sellerId, status: 'open' });
      if (openCount >= AUCTION_MAX_LISTINGS) throw new SlgError('AUCTION_LIMIT_REACHED');
      // Escrow: gear-not-empty/not-found causes meta to throw SlgError (CARD_HAS_GEAR/CARD_NOT_FOUND).
      const instance = await meta.escrowCard(sellerId, instanceId, orderId);
      storedItem = { instance };
      try {
        // C Daily cap — return escrowed card on failure.
        await this.pricing.bumpDaily(sellerId, 'lists', AUCTION_DAILY_LIST_CAP);
      } catch (e) {
        await meta.grantCard(sellerId, instance, `${orderId}:return`);
        throw e;
      }
    } else if (itemType === 'skin') {
      // Skin trade (§9 task4): client sends skinId; server escrows it (removes from inventory.skins) → stores {skinId}.
      const skinId = item['skinId'];
      if (typeof skinId !== 'string') throw new SlgError('BAD_REQUEST');
      const openCount = await cols.auctions.countDocuments({ sellerId, status: 'open' });
      if (openCount >= AUCTION_MAX_LISTINGS) throw new SlgError('AUCTION_LIMIT_REACHED');
      // Escrow: equipped/not-owned causes meta to throw SlgError (SKIN_IN_USE/SKIN_NOT_FOUND).
      const escrowedId = await meta.escrowSkin(sellerId, skinId, orderId);
      storedItem = { skinId: escrowedId };
      try {
        // C Daily cap — return escrowed skin on failure (no price guardrail for skins — cold-start pass-through, market-determined).
        await this.pricing.bumpDaily(sellerId, 'lists', AUCTION_DAILY_LIST_CAP);
      } catch (e) {
        await meta.grantSkin(sellerId, escrowedId, `${orderId}:return`);
        throw e;
      }
    } else {
      throw new SlgError('BAD_REQUEST');
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

    // Authoritative cap enforcement: the per-itemType `openCount >= AUCTION_MAX_LISTINGS` checks above
    // are only a fast-fail optimization against a stale read — they run before this insert, so concurrent
    // createAuction calls from the same seller can all pass them before any of them has inserted. This
    // recount reflects the true persisted state right after the insert, so no race window can leave a
    // seller above the cap. Its only imperfection: under a genuine simultaneous race, more than one
    // concurrent request may be told to retry even though a slot was available for one of them — safety
    // holds (the cap is never exceeded), and a retry immediately succeeds once the field self-corrects.
    const finalOpenCount = await cols.auctions.countDocuments({ sellerId, status: 'open' });
    if (finalOpenCount > AUCTION_MAX_LISTINGS) {
      await cols.auctions.deleteOne({ _id: aid });
      await this.returnEscrowedOnCapReject(sellerId, itemType, storedItem, effectiveQty, `${orderId}:capreturn`);
      throw new SlgError('AUCTION_LIMIT_REACHED');
    }

    return docToView(doc);
  }

  /**
   * Directly returns an escrowed item to the seller (immediate re-grant, not mail — mirrors the
   * escrow-failure rollback already used inline above for equipment/card/skin) after the post-insert
   * AUCTION_MAX_LISTINGS recheck rejects a listing whose escrow already succeeded.
   */
  private async returnEscrowedOnCapReject(
    sellerId: string,
    itemType: 'material' | 'equipment' | 'card' | 'skin',
    storedItem: Record<string, unknown>,
    qty: number,
    orderId: string,
  ): Promise<void> {
    const { meta } = this.deps;
    if (itemType === 'material') {
      const material = storedItem['material'] as string;
      await meta.grantMaterial(sellerId, material, qty, orderId);
    } else if (itemType === 'equipment') {
      const inst = equipInstanceOf(storedItem);
      if (inst) await meta.grantEquipment(sellerId, inst, orderId);
    } else if (itemType === 'card') {
      const inst = cardInstanceOf(storedItem);
      if (inst) await meta.grantCard(sellerId, inst, orderId);
    } else if (itemType === 'skin') {
      const skinId = storedItem['skinId'] as string | undefined;
      if (skinId) await meta.grantSkin(sellerId, skinId, orderId);
    }
  }
}
