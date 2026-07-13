// SLG shop price overrides (SLG_DESIGN §8/G7). admin is the "processing hub": the only service that
// touches the slgShopPrices collection, the only writer, and the sole internal source of raw overrides.
// Operators adjust price/effect in ops → upsertShopItem writes to the DB + audits; worldsvc (no DB
// connection to admin) polls getInternalShopPrices() to retrieve raw overrides and merges them onto
// the SLG_SHOP_ITEMS code defaults locally (resolveSlgShopItem).
import {
  SLG_SHOP_ITEMS,
  isSlgShopItemId,
  type SlgShopItem,
  type SlgShopItemOverrideDoc,
} from '@nw/shared';
import type { Actor, AdminBaseCtor, Constructor } from './base';
import { AdminError } from './errors';
import { validateShopItemInput, describeShopItem } from './validators';

export interface ShopHandlers {
  getShopConfig(): Promise<
    Array<{ id: string; default: SlgShopItem; effective: SlgShopItem; doc: SlgShopItemOverrideDoc | null }>
  >;
  getInternalShopPrices(): Promise<SlgShopItemOverrideDoc[]>;
  upsertShopItem(
    actor: Actor,
    id: string,
    input: { cost?: unknown; effect?: unknown },
  ): Promise<SlgShopItemOverrideDoc>;
}

export function ShopMixin<TBase extends AdminBaseCtor>(Base: TBase): TBase & Constructor<ShopHandlers> {
  return class extends Base {
    // ───────────────────── SLG shop price overrides (§8/G7) ─────────────────────

    /**
     * All 9 shop items with their code default, current effective (default merged with override), and
     * raw override doc (null = using the default). Capability slg.shop.manage, used by the ops list view.
     */
    async getShopConfig(): Promise<
      Array<{ id: string; default: SlgShopItem; effective: SlgShopItem; doc: SlgShopItemOverrideDoc | null }>
    > {
      const docs = await this.cols.slgShopPrices.find({}).toArray();
      const byId = new Map(docs.map((d) => [d._id, d]));
      return SLG_SHOP_ITEMS.map((item) => {
        const doc = byId.get(item.id) ?? null;
        return {
          id: item.id,
          default: item,
          effective: doc
            ? { ...item, ...(doc.cost !== undefined ? { cost: doc.cost } : {}), ...(doc.effect ? { effect: { ...item.effect, ...doc.effect } } : {}) }
            : item,
          doc,
        };
      });
    }

    /** All raw shop price overrides (for the admin internal endpoint GET /admin/internal/slg-shop-prices; returned as-is for worldsvc to merge locally). */
    async getInternalShopPrices(): Promise<SlgShopItemOverrideDoc[]> {
      return this.cols.slgShopPrices.find({}).toArray();
    }

    /**
     * Write/update a shop item's price/effect override (capability slg.shop.manage). Validates that id is
     * one of the 9 catalog items and that cost/effect values are legal; audits every change (actor / before+after).
     */
    async upsertShopItem(
      actor: Actor,
      id: string,
      input: { cost?: unknown; effect?: unknown },
    ): Promise<SlgShopItemOverrideDoc> {
      if (!isSlgShopItemId(id)) throw new AdminError(400, 'bad_request', `unknown shop item id: ${id}`);
      const before = await this.cols.slgShopPrices.findOne({ _id: id });
      const { cost, effect } = validateShopItemInput(input);
      const doc: SlgShopItemOverrideDoc = {
        _id: id,
        ...(cost !== undefined ? { cost } : {}),
        ...(effect ? { effect } : {}),
        updatedAt: this.now(),
        updatedBy: actor.adminId,
      };
      await this.cols.slgShopPrices.replaceOne({ _id: id }, doc, { upsert: true });
      await this.audit(actor.adminId, 'slg.shop.price.update', {
        target: id,
        summary: `${describeShopItem(before)} → ${describeShopItem(doc)}`,
      });
      return doc;
    }
  };
}
