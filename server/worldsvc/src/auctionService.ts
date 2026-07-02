// Auction service business layer (S8-5).
// Tradeable items: materials (scrap/lead/binding, stock in meta SaveData.materials) and equipment.
// SLG season resources (ink/paper/graphite/metal/sticker) are NOT tradeable — prevents strategic arbitrage, preserves biome scarcity.
// Currency: coins (premium, charged/paid via commercial); tax rate 10% (AUCTION_TAX_RATE).
// Expiry: expireAt plain index + scanner (not TTL auto-delete — requires settlement/refund to seller or auction close on expire).
//
// Anti-RMT gates (AUCTION_DESIGN §4):
//   C Daily caps (listing/purchase counts) — auctionDaily counter + TTL auto-clear
//   E Bound-material block — AUCTION_BANNED_MATERIALS
//   G Price guardrail — dynamic sliding-window refPrice + range check (falls back to static values on cold start)
//   F End-of-season freeze/liquidation — world.status settling/closed rejects new listings + clearWorldOnReset refunds
//   B Auction bidding — saleMode='auction': start price / increment / escrow / anti-snipe / settle on expire
import {
  auctionId as makeAuctionId,
  AUCTION_TAX_RATE,
  AUCTION_MAX_LISTINGS,
  AUCTION_DURATIONS_SEC,
  AUCTION_DAILY_LIST_CAP,
  AUCTION_DAILY_BUY_CAP,
  AUCTION_DAILY_TTL_SEC,
  AUCTION_BANNED_MATERIALS,
  AUCTION_PRICE_WINDOW_N,
  AUCTION_PRICE_WINDOW_MIN_SAMPLES,
  AUCTION_PRICE_FLOOR_RATIO,
  AUCTION_PRICE_CEIL_RATIO,
  AUCTION_STATIC_REF_PRICE,
  AUCTION_MIN_INCREMENT_RATIO,
  AUCTION_ANTI_SNIPE_WINDOW_SEC,
  AUDIT_WINDOW_SEC,
  detectAuctionAnomalies,
  EQUIPMENT_DEFS,
  EQUIP_AUCTION_REF_PRICE_BY_RARITY,
  SlgError,
  type AuctionAnomaly,
  type AuctionAuditThresholds,
  type AuctionStatus,
  type AuctionTradeRecord,
  type EquipmentInstance,
  type CardInstance,
} from '@nw/shared';
import type { WorldCollections, AuctionDoc } from './db';
import type { WorldCommercialClient } from './commercialClient';
import type { WorldMetaClient } from './metaClient';
import type { WorldMailClient, WorldMailAttachment } from './mailClient';

export interface AuctionView {
  auctionId: string;
  worldId: string;
  sellerId: string;
  itemType: 'material' | 'equipment' | 'card';
  item: Record<string, unknown>;
  qty: number;
  price: number; // Coin unit price (per item): fixed-price = transaction price; auction = current top-bid unit price (start price if no bids yet)
  totalPrice: number; // Current effective unit price × qty
  currency: 'coins';
  designatedBuyerId?: string;
  expireAt: number; // ms
  status: AuctionStatus;
  buyerId?: string;
  // B Auction fields (saleMode defaults to 'fixed')
  saleMode: 'fixed' | 'auction';
  startPrice?: number;  // Auction start unit price
  buyoutPrice?: number; // Auction buyout (floor) unit price (optional)
  topBid?: { bidderId: string; amount: number; ts: number }; // Current top bid (unit price)
}

export interface AuctionServiceDeps {
  cols: WorldCollections;
  now: () => number;
  commercial: WorldCommercialClient;
  meta: WorldMetaClient;
  mail: WorldMailClient;
}

/** System-mail retention for auction delivery/return items (days) — returned assets must not expire quickly. */
const AUCTION_MAIL_EXPIRE_DAYS = 30;

/** In-process sequence counter to prevent key collisions when multiple listings are created within the same millisecond. */
let auctionSeq = 0;

/** Equipment listing payload (A): full instance snapshot held in escrow (qty always 1 — non-stackable unique instance). */
function equipInstanceOf(item: Record<string, unknown>): EquipmentInstance | null {
  const inst = item['instance'];
  return inst && typeof inst === 'object' ? (inst as EquipmentInstance) : null;
}

/** Card listing payload (CC-5): full CardInstance snapshot held in escrow (qty always 1 — non-stackable unique instance). */
function cardInstanceOf(item: Record<string, unknown>): CardInstance | null {
  const inst = item['instance'];
  return inst && typeof inst === 'object' ? (inst as CardInstance) : null;
}

/** Item category key (price sliding window is isolated per category). Material = `material:{mat}`; equipment = `equip:{defId}`.
 *  Cards return null — no price sliding window (cold-start pass-through; card prices are determined by market). */
function categoryOf(doc: Pick<AuctionDoc, 'itemType' | 'item'>): string | null {
  if (doc.itemType === 'material') {
    const mat = doc.item['material'] as string | undefined;
    return mat ? `material:${mat}` : null;
  }
  if (doc.itemType === 'equipment') {
    const inst = equipInstanceOf(doc.item);
    return inst?.defId ? `equip:${inst.defId}` : null;
  }
  // 'card' and unknown types: no price window
  return null;
}

function docToView(doc: AuctionDoc): AuctionView {
  const saleMode = doc.saleMode ?? 'fixed';
  const effUnit = saleMode === 'auction' ? (doc.topBid?.amount ?? doc.startPrice ?? doc.price) : doc.price;
  return {
    auctionId: doc._id,
    worldId: doc.worldId,
    sellerId: doc.sellerId,
    itemType: doc.itemType as 'material' | 'equipment',
    item: doc.item,
    qty: doc.qty,
    price: effUnit,
    totalPrice: effUnit * doc.qty,
    currency: 'coins',
    ...(doc.designatedBuyerId ? { designatedBuyerId: doc.designatedBuyerId } : {}),
    expireAt: doc.expireAt,
    status: doc.status,
    ...(doc.buyerId ? { buyerId: doc.buyerId } : {}),
    saleMode,
    ...(doc.startPrice != null ? { startPrice: doc.startPrice } : {}),
    ...(doc.buyoutPrice != null ? { buyoutPrice: doc.buyoutPrice } : {}),
    ...(doc.topBid ? { topBid: doc.topBid } : {}),
  };
}

export class AuctionService {
  constructor(private readonly deps: AuctionServiceDeps) {}

  // ── C Daily cap counter (keyed by server UTC day boundary, auto-cleared via TTL) ──────────────────────────
  private dayKey(): string {
    return new Date(this.deps.now()).toISOString().slice(0, 10);
  }

  /**
   * Increments the daily count for a given operation kind by 1. Throws AUCTION_LIMIT_REACHED if the cap is exceeded
   * (and rolls back the increment to prevent permanent lockout).
   * Reserves the slot before executing business logic — standard rate-limiting; the rare over-count from a subsequent
   * business failure is conservatively acceptable.
   */
  private async bumpDaily(worldId: string, accountId: string, kind: 'lists' | 'buys', cap: number): Promise<void> {
    const { cols, now } = this.deps;
    const id = `${worldId}:${accountId}:${this.dayKey()}`;
    const res = await cols.auctionDaily.findOneAndUpdate(
      { _id: id },
      {
        $inc: { [kind]: 1 },
        $setOnInsert: {
          worldId,
          accountId,
          dayKey: this.dayKey(),
          expiresAt: new Date(now() + AUCTION_DAILY_TTL_SEC * 1000),
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    const count = (res?.[kind] as number | undefined) ?? 1;
    if (count > cap) {
      await cols.auctionDaily.updateOne({ _id: id }, { $inc: { [kind]: -1 } });
      throw new SlgError('AUCTION_LIMIT_REACHED');
    }
  }

  // ── G Price guardrail (dynamic sliding window + static fallback) ──────────────────────────────────────
  /** Returns the reference unit price for a category: if the window has enough samples → median; otherwise static fallback; neither available → null (cold-start pass-through). */
  private async refPrice(worldId: string, category: string): Promise<number | null> {
    const doc = await this.deps.cols.auctionPrices.findOne({ _id: `${worldId}:${category}` });
    if (doc && doc.prices.length >= AUCTION_PRICE_WINDOW_MIN_SAMPLES) {
      const sorted = [...doc.prices].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)]!; // median, resistant to extreme values
    }
    if (category.startsWith('material:')) {
      const mat = category.slice('material:'.length);
      const stat = AUCTION_STATIC_REF_PRICE[mat];
      if (stat != null) return stat;
    }
    if (category.startsWith('equip:')) {
      // Equipment cold-start: estimate reference price by rarity (§4.A: price guardrail range is set per rarity).
      const defId = category.slice('equip:'.length);
      const def = EQUIPMENT_DEFS[defId];
      if (def) return EQUIP_AUCTION_REF_PRICE_BY_RARITY[def.rarity];
    }
    return null;
  }

  /** Validates that the unit price falls within the refPrice floating band; passes through if no reference price exists (cold start with no static value). */
  private async checkPriceGuard(worldId: string, category: string | null, unitPrice: number): Promise<void> {
    if (!category) return;
    const ref = await this.refPrice(worldId, category);
    if (ref == null) return;
    if (unitPrice < ref * AUCTION_PRICE_FLOOR_RATIO || unitPrice > ref * AUCTION_PRICE_CEIL_RATIO) {
      throw new SlgError('PRICE_OUT_OF_RANGE');
    }
  }

  /** After each sale, pushes the unit price into the category sliding window (retains the most recent N entries). */
  private async recordSoldPrice(worldId: string, category: string | null, unitPrice: number): Promise<void> {
    if (!category) return;
    await this.deps.cols.auctionPrices.updateOne(
      { _id: `${worldId}:${category}` },
      {
        $push: { prices: { $each: [unitPrice], $slice: -AUCTION_PRICE_WINDOW_N } },
        $setOnInsert: { worldId, category },
      },
      { upsert: true },
    );
  }

  /**
   * Delivers the listed item to the target account via system mail (escrow-out model, AUCTION_DESIGN):
   *   buyer on sale (reason 'sold') / seller on cancel, expiry, or end-of-season reset (reason 'returned').
   * The item does NOT go straight into the inventory — the recipient must claim the mail attachment
   * (equipment/card carry the full instance snapshot; material carries id+qty).
   * dispatchKey = orderId → idempotent (each call site passes a stable, unique orderId).
   * Best-effort: mail unavailable → no-op (same degradation as the previous direct-grant path).
   */
  private async deliverItem(
    toAccountId: string,
    doc: AuctionDoc,
    orderId: string,
    reason: 'sold' | 'returned',
  ): Promise<void> {
    let attachment: WorldMailAttachment | null = null;
    if (doc.itemType === 'material') {
      const material = doc.item['material'] as string;
      attachment = { kind: 'material', id: material, count: doc.qty };
    } else if (doc.itemType === 'equipment') {
      const inst = equipInstanceOf(doc.item);
      if (inst) attachment = { kind: 'equipment', instance: inst };
    } else if (doc.itemType === 'card') {
      const inst = cardInstanceOf(doc.item);
      if (inst) attachment = { kind: 'card', instance: inst };
    }
    if (!attachment) return;
    // subject/body are i18n keys resolved client-side (same mechanism as season-settlement mail, e.g. 'slg.settle.subject').
    await this.deps.mail.sendSystemMail(toAccountId, orderId, {
      subject: `auction.mail.${reason}.subject`,
      body: `auction.mail.${reason}.body`,
      attachments: [attachment],
      expireDays: AUCTION_MAIL_EXPIRE_DAYS,
    });
  }

  // ── F End-of-season freeze: settling/closed worlds reject new listings (buy/cancel/settle are unrestricted) ─────────────
  private async assertWorldAcceptsListings(worldId: string): Promise<void> {
    const world = await this.deps.cols.worlds.findOne({ _id: worldId });
    if (world && (world.status === 'settling' || world.status === 'closed')) {
      throw new SlgError('WORLD_CLOSED');
    }
  }

  /** Lists open auctions in a world (optionally filtered by itemType, sorted by price ascending, limit ≤50). */
  async listAuctions(worldId: string, itemType?: string, limit = 20): Promise<AuctionView[]> {
    const query: Record<string, unknown> = { worldId, status: 'open' };
    if (itemType) query['itemType'] = itemType;
    const docs = await this.deps.cols.auctions
      .find(query)
      .sort({ price: 1 })
      .limit(Math.min(Math.max(limit, 1), 50))
      .toArray();
    return docs.map(docToView);
  }

  /** My listings (all statuses). */
  async getMyListings(worldId: string, accountId: string): Promise<AuctionView[]> {
    const docs = await this.deps.cols.auctions
      .find({ worldId, sellerId: accountId })
      .sort({ expireAt: -1 })
      .limit(AUCTION_MAX_LISTINGS)
      .toArray();
    return docs.map(docToView);
  }

  /**
   * Create a listing.
   * itemType='material' → deducts materials from meta (orderId-idempotent).
   * itemType='equipment' → meta.escrowEquipment holds the instance in escrow (equipped/locked/not found → SlgError).
   * saleMode='fixed' (default): price = buyout unit price.
   * saleMode='auction': startPrice = starting unit price, buyoutPrice? = optional buyout floor unit price.
   * durationSec must be one of AUCTION_DURATIONS_SEC; open listings per account ≤ AUCTION_MAX_LISTINGS;
   * daily new listings ≤ AUCTION_DAILY_LIST_CAP (C); banned materials rejected (E); unit price out of range rejected (G); settling world rejected (F).
   */
  async createAuction(params: {
    worldId: string;
    sellerId: string;
    itemType: 'material' | 'equipment' | 'card';
    item: Record<string, unknown>;
    qty: number;
    price?: number; // fixed mode: buyout unit price
    saleMode?: 'fixed' | 'auction';
    startPrice?: number; // auction mode: start unit price
    buyoutPrice?: number; // auction mode: buyout floor unit price (optional)
    durationSec: number;
    designatedBuyerId?: string;
  }): Promise<AuctionView> {
    const {
      worldId, sellerId, itemType, item, qty, durationSec, designatedBuyerId,
    } = params;
    const saleMode = params.saleMode ?? 'fixed';
    const { cols, now, meta } = this.deps;

    if (!AUCTION_DURATIONS_SEC.includes(durationSec)) throw new SlgError('BAD_REQUEST');
    // Equipment and card qty is always 1 (non-stackable unique instances); material qty must be > 0.
    const effectiveQty = (itemType === 'equipment' || itemType === 'card') ? 1 : qty;
    if (effectiveQty <= 0) throw new SlgError('BAD_REQUEST');

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

    // F End-of-season freeze
    await this.assertWorldAcceptsListings(worldId);

    const ts = now();
    const seq = ++auctionSeq;
    const aid = makeAuctionId(worldId, sellerId, ts, seq);
    const orderId = `auction_list:${aid}`;
    let storedItem: Record<string, unknown> = item;

    if (itemType === 'material') {
      // E Bound-material block
      const material = item['material'] as string | undefined;
      if (!material) throw new SlgError('BAD_REQUEST');
      if (AUCTION_BANNED_MATERIALS.has(material)) throw new SlgError('MATERIAL_NOT_TRADEABLE');
      // G Price guardrail (validate unit price against category reference price)
      await this.checkPriceGuard(worldId, categoryOf({ itemType, item }), unitPrice);
      // Concurrent listing count cap
      const openCount = await cols.auctions.countDocuments({ worldId, sellerId, status: 'open' });
      if (openCount >= AUCTION_MAX_LISTINGS) throw new SlgError('AUCTION_LIMIT_REACHED');
      // C Daily new-listing cap (reserve slot)
      await this.bumpDaily(worldId, sellerId, 'lists', AUCTION_DAILY_LIST_CAP);
      // Deduct material from meta (escrow)
      await meta.deductMaterial(sellerId, material, qty, orderId);
    } else if (itemType === 'equipment') {
      // A Equipment trade: client sends instanceId; server escrows the full instance (removes from seller inventory) → stores snapshot.
      const instanceId = item['instanceId'];
      if (typeof instanceId !== 'string') throw new SlgError('BAD_REQUEST');
      // Concurrent listing count cap (check before escrow to avoid unnecessary escrow+return roundtrip)
      const openCount = await cols.auctions.countDocuments({ worldId, sellerId, status: 'open' });
      if (openCount >= AUCTION_MAX_LISTINGS) throw new SlgError('AUCTION_LIMIT_REACHED');
      // Escrow: equipped/locked/not-found causes meta to throw SlgError (EQUIP_IN_USE/EQUIP_LOCKED/EQUIP_NOT_FOUND).
      const instance = await meta.escrowEquipment(sellerId, instanceId, orderId);
      storedItem = { instance };
      try {
        // G Price guardrail (equipment by defId/rarity category) + C daily cap — return escrowed instance on failure.
        await this.checkPriceGuard(worldId, `equip:${instance.defId}`, unitPrice);
        await this.bumpDaily(worldId, sellerId, 'lists', AUCTION_DAILY_LIST_CAP);
      } catch (e) {
        await meta.grantEquipment(sellerId, instance, `${orderId}:return`);
        throw e;
      }
    } else if (itemType === 'card') {
      // CC-5 Card trade: client sends instanceId; server escrows the full instance (validates gear all empty, removes from cardInv) → stores snapshot.
      const instanceId = item['instanceId'];
      if (typeof instanceId !== 'string') throw new SlgError('BAD_REQUEST');
      const openCount = await cols.auctions.countDocuments({ worldId, sellerId, status: 'open' });
      if (openCount >= AUCTION_MAX_LISTINGS) throw new SlgError('AUCTION_LIMIT_REACHED');
      // Escrow: gear-not-empty/not-found causes meta to throw SlgError (CARD_HAS_GEAR/CARD_NOT_FOUND).
      const instance = await meta.escrowCard(sellerId, instanceId, orderId);
      storedItem = { instance };
      try {
        // C Daily cap — return escrowed card on failure.
        await this.bumpDaily(worldId, sellerId, 'lists', AUCTION_DAILY_LIST_CAP);
      } catch (e) {
        await meta.grantCard(sellerId, instance, `${orderId}:return`);
        throw e;
      }
    } else {
      throw new SlgError('BAD_REQUEST');
    }

    const doc: AuctionDoc = {
      _id: aid,
      worldId,
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
    return docToView(doc);
  }

  /**
   * Purchase an auction listing (fixed-price only; atomically claims status open→sold).
   * Designated-buyer check → daily cap (C) → deduct buyer coins → atomic status update → deliver item → pay seller (after tax).
   * If buyer deduction succeeds but a subsequent step fails: item remains in sold state; ops admin can look up orderId and manually redeliver.
   * Auction listings (saleMode='auction') do not go through this path — bidding/buyout uses placeBid.
   */
  async buyAuction(worldId: string, buyerId: string, auctionId: string): Promise<AuctionView> {
    const { cols, now, commercial } = this.deps;

    const doc = await cols.auctions.findOne({ _id: auctionId, worldId });
    if (!doc) throw new SlgError('AUCTION_NOT_FOUND');
    if (doc.status !== 'open') throw new SlgError('AUCTION_CLOSED');
    if ((doc.saleMode ?? 'fixed') !== 'fixed') throw new SlgError('BAD_REQUEST'); // auction listings use placeBid
    if (doc.sellerId === buyerId) throw new SlgError('BAD_REQUEST');
    if (doc.expireAt < now()) throw new SlgError('AUCTION_CLOSED');
    if (doc.designatedBuyerId && doc.designatedBuyerId !== buyerId) {
      throw new SlgError('NOT_DESIGNATED_BUYER');
    }

    // C Daily purchase cap (reserve slot before charging)
    await this.bumpDaily(worldId, buyerId, 'buys', AUCTION_DAILY_BUY_CAP);

    const totalPrice = doc.price * doc.qty;
    const tax = Math.floor(totalPrice * AUCTION_TAX_RATE);
    const sellerReceives = totalPrice - tax;

    const buyOrderId = `auction_buy:${auctionId}`;

    // 1. Deduct coins from buyer (insufficient funds → throw, no sale)
    await commercial.spend(buyerId, totalPrice, buyOrderId);

    // 2. Atomic status open→sold (prevents concurrent double-purchase)
    const updated = await cols.auctions.findOneAndUpdate(
      { _id: auctionId, status: 'open' },
      { $set: { status: 'sold', buyerId, soldAt: now(), rev: doc.rev + 1 } },
      { returnDocument: 'after' },
    );
    if (!updated) {
      // Concurrently sniped by another buyer → refund buyer coins (best-effort)
      await commercial.grant(buyerId, totalPrice, `${buyOrderId}:refund`);
      throw new SlgError('AUCTION_CLOSED');
    }

    // 3. Deliver item to buyer via system mail (escrow-out: buyer claims the attachment)
    await this.deliverItem(buyerId, doc, `${buyOrderId}:item`, 'sold');

    // 4. Pay seller coins (after tax, best-effort)
    await commercial.grant(doc.sellerId, sellerReceives, `${buyOrderId}:seller`);

    // G Record sale unit price into sliding window
    await this.recordSoldPrice(worldId, categoryOf(doc), doc.price);

    return docToView(updated);
  }

  /**
   * Place an auction bid (saleMode='auction', B).
   * amount = bid unit price (coins/item); escrowed total = amount × qty.
   * Validate → daily cap → escrow bid coins → atomic topBid write (rev guard) → refund previous bidder → anti-snipe extension.
   * If amount reaches/exceeds buyoutPrice → immediate settlement (item to bidder, seller receives post-tax proceeds; coins already escrowed, no second deduction).
   */
  async placeBid(worldId: string, bidderId: string, auctionId: string, amount: number): Promise<AuctionView> {
    const { cols, now, commercial } = this.deps;
    if (amount <= 0) throw new SlgError('BAD_REQUEST');

    const doc = await cols.auctions.findOne({ _id: auctionId, worldId });
    if (!doc) throw new SlgError('AUCTION_NOT_FOUND');
    if (doc.status !== 'open') throw new SlgError('AUCTION_CLOSED');
    if ((doc.saleMode ?? 'fixed') !== 'auction') throw new SlgError('BAD_REQUEST'); // fixed-price listings use buyAuction
    if (doc.sellerId === bidderId) throw new SlgError('BAD_REQUEST');
    if (doc.expireAt < now()) throw new SlgError('AUCTION_CLOSED');
    if (doc.designatedBuyerId && doc.designatedBuyerId !== bidderId) {
      throw new SlgError('NOT_DESIGNATED_BUYER');
    }

    // Minimum bid: start price / current top bid + minimum increment
    const startPrice = doc.startPrice ?? doc.price;
    let minBid = startPrice;
    if (doc.topBid) {
      const inc = Math.max(1, Math.floor(doc.topBid.amount * AUCTION_MIN_INCREMENT_RATIO));
      minBid = doc.topBid.amount + inc;
    }
    if (amount < minBid) throw new SlgError('BID_TOO_LOW');

    // G Price guardrail (bid unit price is also subject to the guardrail)
    await this.checkPriceGuard(worldId, categoryOf(doc), amount);

    // C Daily bid cap
    await this.bumpDaily(worldId, bidderId, 'buys', AUCTION_DAILY_BUY_CAP);

    const prevBid = doc.topBid;
    const escrowTotal = amount * doc.qty;
    const bidOrderId = `auction_bid:${auctionId}:${bidderId}:${amount}`;

    // 1. Escrow bid coins (insufficient funds → throw, topBid unchanged)
    await commercial.spend(bidderId, escrowTotal, bidOrderId);

    // 2. Anti-snipe: bid placed within window before expiry → extend expireAt by the same window
    const ts = now();
    const windowMs = AUCTION_ANTI_SNIPE_WINDOW_SEC * 1000;
    const newExpireAt = doc.expireAt - ts < windowMs ? ts + windowMs : doc.expireAt;

    // 3. Atomic topBid write (rev guard prevents concurrent bid overwrite)
    const updated = await cols.auctions.findOneAndUpdate(
      { _id: auctionId, status: 'open', rev: doc.rev },
      {
        $set: { topBid: { bidderId, amount, ts }, expireAt: newExpireAt, rev: doc.rev + 1 },
      },
      { returnDocument: 'after' },
    );
    if (!updated) {
      // Concurrently superseded or already closed → refund this escrow
      await commercial.grant(bidderId, escrowTotal, `${bidOrderId}:refund`);
      throw new SlgError('AUCTION_CLOSED');
    }

    // 4. Refund previous top bidder's escrowed coins (best-effort, idempotent)
    if (prevBid) {
      await commercial.grant(
        prevBid.bidderId,
        prevBid.amount * doc.qty,
        `auction_bid_refund:${auctionId}:${prevBid.bidderId}:${prevBid.amount}`,
      );
    }

    // 5. Buyout: bid reaches/exceeds buyoutPrice → immediate settlement
    if (doc.buyoutPrice != null && amount >= doc.buyoutPrice) {
      return this.settleAuctionWin(updated, commercial);
    }
    return docToView(updated);
  }

  /**
   * Settle an auction win (internal): deliver item to the top bidder and pay seller post-tax proceeds (coins already escrowed, no second deduction).
   * Atomic open→sold prevents double-settlement with the expiry scanner or a concurrent buyout. If concurrently already settled → read and return the current state.
   */
  private async settleAuctionWin(
    doc: AuctionDoc,
    commercial: WorldCommercialClient,
  ): Promise<AuctionView> {
    const top = doc.topBid!;
    const updated = await this.deps.cols.auctions.findOneAndUpdate(
      { _id: doc._id, status: 'open' },
      { $set: { status: 'sold', buyerId: top.bidderId, soldAt: this.deps.now(), rev: doc.rev + 1 } },
      { returnDocument: 'after' },
    );
    if (!updated) {
      const cur = await this.deps.cols.auctions.findOne({ _id: doc._id });
      return docToView(cur ?? doc);
    }

    const totalPrice = top.amount * doc.qty;
    const tax = Math.floor(totalPrice * AUCTION_TAX_RATE);
    const sellerReceives = totalPrice - tax;
    const orderId = `auction_settle:${doc._id}`;

    // Deliver item to the winner via system mail (escrow-out: winner claims the attachment)
    await this.deliverItem(top.bidderId, doc, `${orderId}:item`, 'sold');
    // Pay seller post-tax proceeds
    await commercial.grant(doc.sellerId, sellerReceives, `${orderId}:seller`);
    // G Record sale unit price
    await this.recordSoldPrice(doc.worldId, categoryOf(doc), top.amount);

    return docToView(updated);
  }

  /**
   * Cancel a listing (seller only, status=open).
   * Auction listing with existing bids → cancel rejected (protects bidders); zero bids → can cancel.
   * Refund item to seller (material / equipment instance, best-effort).
   */
  async cancelAuction(worldId: string, sellerId: string, auctionId: string): Promise<AuctionView> {
    const { cols } = this.deps;

    const doc = await cols.auctions.findOne({ _id: auctionId, worldId });
    if (!doc) throw new SlgError('AUCTION_NOT_FOUND');
    if (doc.sellerId !== sellerId) throw new SlgError('NO_PERMISSION');
    if (doc.status !== 'open') throw new SlgError('AUCTION_CLOSED');
    if ((doc.saleMode ?? 'fixed') === 'auction' && doc.topBid) throw new SlgError('BAD_REQUEST'); // cannot cancel with existing bids

    const updated = await cols.auctions.findOneAndUpdate(
      { _id: auctionId, status: 'open' },
      { $set: { status: 'cancelled', rev: doc.rev + 1 } },
      { returnDocument: 'after' },
    );
    if (!updated) throw new SlgError('AUCTION_CLOSED');

    // Return item to seller via system mail (escrow-out: seller claims the attachment to get it back)
    await this.deliverItem(sellerId, doc, `auction_cancel:${auctionId}`, 'returned');

    return docToView(updated);
  }

  /**
   * Process expired listings (called periodically by the scheduler).
   * Batch-scans expireAt < now AND status=open:
   *   Auction listing with a topBid → settle (deliver item to top bidder, pay seller post-tax);
   *   Otherwise (fixed-price expired / auction with no bids) → mark expired + return item to seller.
   * At most 50 documents per batch to prevent overly long single scans.
   */
  async processExpiredAuctions(): Promise<number> {
    const { cols, now, commercial } = this.deps;
    const ts = now();
    const expired = await cols.auctions
      .find({ status: 'open', expireAt: { $lt: ts } })
      .limit(50)
      .toArray();

    let processed = 0;
    for (const doc of expired) {
      const isAuctionWin = (doc.saleMode ?? 'fixed') === 'auction' && !!doc.topBid;
      if (isAuctionWin) {
        // Settle auction win (settleAuctionWin contains atomic open→sold to prevent concurrent double-settle)
        await this.settleAuctionWin(doc, commercial);
        processed++;
        continue;
      }

      // Atomic open→expired (prevents concurrent double-processing)
      const res = await cols.auctions.findOneAndUpdate(
        { _id: doc._id, status: 'open' },
        { $set: { status: 'expired', rev: doc.rev + 1 } },
        { returnDocument: 'after' },
      );
      if (!res) continue; // concurrently claimed by another processor, skip

      // Return item to seller via system mail (escrow-out: seller claims the attachment to get it back)
      await this.deliverItem(doc.sellerId, doc, `auction_expire:${doc._id}`, 'returned');
      processed++;
    }
    return processed;
  }

  /**
   * F End-of-season liquidation: forcibly liquidates all open listings in a world on season reset.
   * Batch open→cancelled + return item to seller + refund escrowed auction bids; clears the world's price sliding window (market restarts for the new season).
   * Called by /admin/world/reset outside svc.resetSeason (auction items belong to the progression side, safe to return, SLG4).
   */
  async clearWorldOnReset(worldId: string): Promise<{ cancelled: number }> {
    const { cols, commercial } = this.deps;
    let cancelled = 0;
    // Loop until no open listings remain (batched when volume is large, ≤100 per batch)
    for (;;) {
      const open = await cols.auctions.find({ worldId, status: 'open' }).limit(100).toArray();
      if (open.length === 0) break;
      for (const doc of open) {
        const res = await cols.auctions.findOneAndUpdate(
          { _id: doc._id, status: 'open' },
          { $set: { status: 'cancelled', rev: doc.rev + 1 } },
          { returnDocument: 'after' },
        );
        if (!res) continue;
        // Return item to seller via system mail (escrow-out: seller claims the attachment to get it back)
        await this.deliverItem(doc.sellerId, doc, `auction_reset:${doc._id}`, 'returned');
        // Refund escrowed auction bid (if any)
        if ((doc.saleMode ?? 'fixed') === 'auction' && doc.topBid) {
          await commercial.grant(
            doc.topBid.bidderId,
            doc.topBid.amount * doc.qty,
            `auction_reset_refund:${doc._id}`,
          );
        }
        cancelled++;
      }
    }
    // Clear the world's price sliding window (market restarts for the new season; refPrice must not bleed across seasons)
    await cols.auctionPrices.deleteMany({ worldId });
    return { cancelled };
  }

  // ── D / G7 Anomalous-trade audit scan (anti-RMT, SLG_DESIGN §17.7) ─────────────────────
  /** Falls back to parsing the listing timestamp from the auctionId (`a:{worldId}:{sellerId}:{ts}:{seq}`) when legacy documents lack a soldAt field. */
  private soldTs(doc: AuctionDoc): number {
    if (typeof doc.soldAt === 'number') return doc.soldAt;
    const parts = doc._id.split(':');
    const ts = Number(parts[3]);
    return Number.isFinite(ts) ? ts : 0;
  }

  /** Gross sale amount (coins, before tax) for a sold document. Auction: top-bid unit price; fixed: price field; multiplied by qty. */
  private grossCoins(doc: AuctionDoc): number {
    const unit = (doc.saleMode ?? 'fixed') === 'auction'
      ? (doc.topBid?.amount ?? doc.startPrice ?? doc.price)
      : doc.price;
    return unit * doc.qty;
  }

  /**
   * Scans recent sold auctions in a world and aggregates suspicious seller→buyer pairs (detectAuctionAnomalies).
   * Offline read-only — does not mutate any state. Results are pulled by the admin backend into an audit queue for ops review (G7).
   * windowSec defaults to AUDIT_WINDOW_SEC; thresholds can be overridden for tuning.
   */
  async scanAnomalies(
    worldId: string,
    windowSec: number = AUDIT_WINDOW_SEC,
    thresholds: AuctionAuditThresholds = {},
  ): Promise<AuctionAnomaly[]> {
    const since = this.deps.now() - windowSec * 1000;
    // sold documents may include legacy records without soldAt → do not filter by soldAt in Mongo (would miss old docs); fetch all sold docs
    // then window-filter by soldTs in memory (sold volume is far smaller than open, and isolated by worldId — acceptable).
    const docs = await this.deps.cols.auctions
      .find({ worldId, status: 'sold' })
      .limit(5000)
      .toArray();
    const trades: AuctionTradeRecord[] = [];
    for (const doc of docs) {
      if (!doc.buyerId) continue;
      const ts = this.soldTs(doc);
      if (ts < since) continue;
      trades.push({
        sellerId: doc.sellerId,
        buyerId: doc.buyerId,
        designated: !!doc.designatedBuyerId && doc.designatedBuyerId === doc.buyerId,
        coins: this.grossCoins(doc),
        ts,
      });
    }
    return detectAuctionAnomalies(trades, thresholds);
  }
}
