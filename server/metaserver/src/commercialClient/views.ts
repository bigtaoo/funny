// Data shapes crossing the meta ↔ commercial internal HTTP boundary — the payloads only, no calls.
//
// Split out of commercialClient.ts (2026-09-07) when adding appleNotification pushed that file past
// the 500-line convention. These are the leaf of the dependency chain: they name what the wire
// carries and import nothing from the client, so they move without touching a single call site
// (commercialClient.ts re-exports every public name, keeping `from '../commercialClient.js'` valid).
import type { Rarity, LimitedPoolConfig, CustomPoolConfig } from '@nw/shared';

export interface GachaResultEntry {
  itemId: string;
  rarity: Rarity;
}

export interface UndeliveredOrder {
  _id: string;
  accountId: string;
  // 'fate'/'starter' deliver items like a gacha order (skins/materials/equipment/cards); see economy.deliverOrder.
  kind: 'shop' | 'gacha' | 'fate' | 'starter';
  // qty: units charged together in one shopCharge call (bulk-buy, 2026-08-10); absent/1 for a single-unit
  // shop order and for every non-'shop' kind. deliverOrder's kind==='shop' branch reads this to grant the
  // full quantity on reconciliation, not just 1, when a bulk buy crashed between charge and delivery.
  result: { itemId?: string; results?: GachaResultEntry[]; poolId?: string; qty?: number };
}

/** Wallet view mirrored into SaveData (coins/pity + monetization state §5–§7/§13). */
export interface WalletView {
  coins: number;
  pity: Record<string, number>;
  fatePoints: number;
  subscriptionExpiry: number;
  subscriptionLastClaimDay?: string; // UTC day (YYYY-MM-DD) of last daily-coin claim; absent = never claimed
  starterUsed: string[];
  firstPurchaseUsed: boolean; // true once the first-purchase 2× bonus has been claimed
  totalRechargeCents: number; // lifetime cumulative real-money spend (usdCents), GACHA_DESIGN §13
}

/** Audit fields commercial stamps on every stored pool config. */
interface GachaPoolAudit {
  createdBy: string;
  createdAt: number;
  closedAt?: number;
}

/**
 * A pool config as stored/listed by commercial. Discriminated by `kind` (absent = derived, GACHA_DESIGN §2.2;
 * 'custom' = ops-authored free-form pool, §12). meta.getGachaPools branches on it to build the client view.
 */
export type GachaPoolView =
  | (LimitedPoolConfig & GachaPoolAudit & { kind?: 'derived' })
  | (CustomPoolConfig & GachaPoolAudit & { kind: 'custom' });

/** Every internal endpoint answers this envelope. */
export type Body<T> = ({ ok: true } & T) | { ok: false; error: string };
export interface CoinGainRow {
  accountId: string;
  nonRechargeGain: number;
}

export interface PaddleEventView {
  transactionId: string;
  eventType: string;
  status?: string;
  accountId?: string;
  rawEvent: string;
  ts: number;
}

export interface PromoCodeView {
  code: string;
  coins: number;
  expiresAt?: number;
  totalLimit?: number;
  redeemed: number;
  note?: string;
  createdBy: string;
  createdAt: number;
}
