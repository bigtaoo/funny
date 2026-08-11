// auctionsvc AuctionService split — C daily caps + G price guardrail (see ../auctionService.ts).
//
// Independent sibling class (2026-08-11 re-audit, converted from a linear inheritance chain to
// composition): zero dependencies on any other layer, only `deps` — the DAG root, depended on by
// create.ts and trade.ts. `bumpDaily`/`checkPriceGuard`/`recordSoldPrice` moved from `protected`
// to public (siblings call them via `this.pricing.xxx(...)`, not through inheritance).
import {
  AUCTION_DAILY_TTL_SEC,
  AUCTION_PRICE_WINDOW_MIN_SAMPLES,
  AUCTION_PRICE_FLOOR_RATIO,
  AUCTION_PRICE_CEIL_RATIO,
  AUCTION_STATIC_REF_PRICE,
  AUCTION_PRICE_WINDOW_N,
  EQUIPMENT_DEFS,
  EQUIP_AUCTION_REF_PRICE_BY_RARITY,
  equipEnhanceExpectedCost,
  SlgError,
} from '@nw/shared';
import type { AuctionServiceDeps } from './base';

export class AuctionServicePricing {
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
  async bumpDaily(accountId: string, kind: 'lists' | 'buys', cap: number): Promise<void> {
    const { cols, now } = this.deps;
    const id = `${accountId}:${this.dayKey()}`;
    const res = await cols.auctionDaily.findOneAndUpdate(
      { _id: id },
      {
        $inc: { [kind]: 1 },
        $setOnInsert: {
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
  private async refPrice(category: string): Promise<number | null> {
    const doc = await this.deps.cols.auctionPrices.findOne({ _id: category });
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
      // Equipment cold-start: base rarity value + expected enhancement investment (§4.A: price guardrail
      // range is set per rarity+level, so a heavily-enhanced instance isn't priced as if it were +0).
      const [defId, levelStr] = category.slice('equip:'.length).split(':');
      const def = defId ? EQUIPMENT_DEFS[defId] : undefined;
      if (def) {
        const level = Number(levelStr ?? 0) || 0;
        return EQUIP_AUCTION_REF_PRICE_BY_RARITY[def.rarity] + equipEnhanceExpectedCost(level, AUCTION_STATIC_REF_PRICE);
      }
    }
    return null;
  }

  /** Validates that the unit price falls within the refPrice floating band; passes through if no reference price exists (cold start with no static value). */
  async checkPriceGuard(category: string | null, unitPrice: number): Promise<void> {
    if (!category) return;
    const ref = await this.refPrice(category);
    if (ref == null) return;
    if (unitPrice < ref * AUCTION_PRICE_FLOOR_RATIO || unitPrice > ref * AUCTION_PRICE_CEIL_RATIO) {
      throw new SlgError('PRICE_OUT_OF_RANGE');
    }
  }

  /**
   * Public read of the price guardrail band for a category, so the create-listing UI can show the seller
   * the acceptable range *before* they submit (instead of only surfacing PRICE_OUT_OF_RANGE after the fact).
   * Returns the authoritative reference unit price (dynamic median or static fallback) and the same
   * [ref×FLOOR, ref×CEIL] bounds checkPriceGuard enforces, or null when the category is unguarded /
   * cold-start pass-through (any price allowed).
   */
  async getRefBand(category: string | null): Promise<{ ref: number; floor: number; ceil: number } | null> {
    if (!category) return null;
    const ref = await this.refPrice(category);
    if (ref == null) return null;
    return { ref, floor: ref * AUCTION_PRICE_FLOOR_RATIO, ceil: ref * AUCTION_PRICE_CEIL_RATIO };
  }

  /** After each sale, pushes the unit price into the category sliding window (retains the most recent N entries). */
  async recordSoldPrice(category: string | null, unitPrice: number): Promise<void> {
    if (!category) return;
    await this.deps.cols.auctionPrices.updateOne(
      { _id: category },
      {
        $push: { prices: { $each: [unitPrice], $slice: -AUCTION_PRICE_WINDOW_N } },
        $setOnInsert: { category },
      },
      { upsert: true },
    );
  }
}
