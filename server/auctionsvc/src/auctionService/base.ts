// auctionsvc AuctionService split — shared kernel (2026-08-09, AuctionService god-class split;
// 2026-08-11 re-audited and converted from a linear inheritance chain to composition, see
// claudedocs/server.md's 2026-08-11 note). Holds the deps/view types and the stateless doc↔view
// mapping helpers every sibling class builds on — no behavior change, methods copied verbatim
// from the original auctionService.ts. `AuctionServiceDeps` has no methods of its own (unlike
// AdminCore/WalletCore/MetaCore in the other 6 chains converted the same day), so there's no
// need for a wrapper "Core" class here — every sibling just takes `deps: AuctionServiceDeps`
// directly in its constructor.
import { type AuctionListingAdminView, type AuctionStatus, type EquipmentInstance, type CardInstance } from '@nw/shared';
import type { AuctionCollections, AuctionDoc } from '../db';
import type { AuctionCommercialClient } from '../commercialClient';
import type { AuctionMetaClient } from '../metaClient';
import type { AuctionMailClient } from '../mailClient';

export interface AuctionView {
  auctionId: string;
  sellerId: string;
  itemType: 'material' | 'equipment' | 'card' | 'skin';
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
  cols: AuctionCollections;
  now: () => number;
  commercial: AuctionCommercialClient;
  meta: AuctionMetaClient;
  mail: AuctionMailClient;
}

/** System-mail retention for auction delivery/return items (days) — returned assets must not expire quickly. */
export const AUCTION_MAIL_EXPIRE_DAYS = 30;

/**
 * Retention window (seconds) for closed listings (sold/cancelled/expired) in a seller's My-Listings history
 * before the scheduler purges them — keeps recent history visible but bounds unbounded list growth (~30 days).
 * Must stay ≥ AUDIT_WINDOW_SEC (7d) so the anomaly audit never loses in-window sold docs to this purge.
 */
export const AUCTION_CLOSED_RETENTION_SEC = 30 * 24 * 3600;

/** Fetch cap for getMyListings — larger than AUCTION_MAX_LISTINGS (open cap) to leave room for retained closed history. */
export const MY_LISTINGS_FETCH_LIMIT = 100;

/** Fetch cap for queryListings when an itemName filter is applied (filtered in memory, see queryListings). */
export const QUERY_FETCH_CAP = 500;

/** In-process sequence counter to prevent key collisions when multiple listings are created within the same millisecond. */
let auctionSeq = 0;

/** Claims the next auction sequence number (module-private counter; exported as a function since a `let` binding can't be mutated from an importing module). */
export function nextAuctionSeq(): number {
  return ++auctionSeq;
}

/** Auction ID: `a:{sellerId}:{ts}:{seq}` (worldId dropped, AUCTION_DESIGN §9). */
export function makeAuctionId(sellerId: string, ts: number, seq: number): string {
  return `a:${sellerId}:${ts}:${seq}`;
}

/** Equipment listing payload (A): full instance snapshot held in escrow (qty always 1 — non-stackable unique instance). */
export function equipInstanceOf(item: Record<string, unknown>): EquipmentInstance | null {
  const inst = item['instance'];
  return inst && typeof inst === 'object' ? (inst as EquipmentInstance) : null;
}

/** Card listing payload (CC-5): full CardInstance snapshot held in escrow (qty always 1 — non-stackable unique instance). */
export function cardInstanceOf(item: Record<string, unknown>): CardInstance | null {
  const inst = item['instance'];
  return inst && typeof inst === 'object' ? (inst as CardInstance) : null;
}

/** Item category key (price sliding window is isolated per category). Material = `material:{mat}`; equipment = `equip:{defId}:{level}`
 *  (bucketed by enhancement level — a +9 sale must not get diluted into the same median as a +0 sale of the same defId).
 *  Cards and skins return null — no price sliding window (cold-start pass-through; prices are determined by market). */
export function categoryOf(doc: Pick<AuctionDoc, 'itemType' | 'item'>): string | null {
  if (doc.itemType === 'material') {
    const mat = doc.item['material'] as string | undefined;
    return mat ? `material:${mat}` : null;
  }
  if (doc.itemType === 'equipment') {
    const inst = equipInstanceOf(doc.item);
    return inst?.defId ? `equip:${inst.defId}:${inst.level}` : null;
  }
  // 'card', 'skin' and unknown types: no price window
  return null;
}

/** Derived display name for ops lookup: material name / equipment defId / card defId / skinId. */
function itemNameOf(doc: Pick<AuctionDoc, 'itemType' | 'item'>): string {
  if (doc.itemType === 'material') return (doc.item['material'] as string | undefined) ?? '';
  if (doc.itemType === 'equipment') return equipInstanceOf(doc.item)?.defId ?? '';
  if (doc.itemType === 'card') return cardInstanceOf(doc.item)?.defId ?? '';
  if (doc.itemType === 'skin') return (doc.item['skinId'] as string | undefined) ?? '';
  return '';
}

export function docToAdminView(doc: AuctionDoc): AuctionListingAdminView {
  return {
    auctionId: doc._id,
    sellerId: doc.sellerId,
    itemType: doc.itemType as AuctionListingAdminView['itemType'],
    itemName: itemNameOf(doc),
    item: doc.item,
    qty: doc.qty,
    price: doc.price,
    currency: doc.currency,
    ...(doc.designatedBuyerId ? { designatedBuyerId: doc.designatedBuyerId } : {}),
    expireAt: doc.expireAt,
    status: doc.status,
    ...(doc.buyerId ? { buyerId: doc.buyerId } : {}),
    ...(doc.soldAt != null ? { soldAt: doc.soldAt } : {}),
    ...(doc.closedAt != null ? { closedAt: doc.closedAt } : {}),
    saleMode: doc.saleMode ?? 'fixed',
    ...(doc.startPrice != null ? { startPrice: doc.startPrice } : {}),
    ...(doc.buyoutPrice != null ? { buyoutPrice: doc.buyoutPrice } : {}),
    ...(doc.topBid ? { topBid: doc.topBid } : {}),
    rev: doc.rev,
  };
}

export function docToView(doc: AuctionDoc): AuctionView {
  const saleMode = doc.saleMode ?? 'fixed';
  const effUnit = saleMode === 'auction' ? (doc.topBid?.amount ?? doc.startPrice ?? doc.price) : doc.price;
  return {
    auctionId: doc._id,
    sellerId: doc.sellerId,
    itemType: doc.itemType as AuctionView['itemType'],
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

