// Promo code management (B-PROMO, promo.manage). Proxies the commercial promo store + audit.
import type { PromoCodeView } from '../clients';
import type { Actor, AdminBaseCtor, Constructor } from './base';
import { AdminError } from './errors';

export interface PromoHandlers {
  listPromoCodes(): Promise<PromoCodeView[]>;
  createPromoCode(
    actor: Actor,
    args: { code: string; coins: number; expiresAt?: number; totalLimit?: number; note?: string },
  ): Promise<{ code: string }>;
}

export function PromoMixin<TBase extends AdminBaseCtor>(Base: TBase): TBase & Constructor<PromoHandlers> {
  return class extends Base {
    // ───────────────────── Promo code management (B-PROMO, promo.manage) ──────────────────────────
    /** List all promo codes; returns an empty list if commercial is unreachable. */
    async listPromoCodes(): Promise<PromoCodeView[]> {
      if (!this.promo.available) return [];
      return this.promo.list();
    }

    /** Create a promo code. Audited. Throws AdminError if commercial is unreachable or the code already exists. */
    async createPromoCode(
      actor: Actor,
      args: { code: string; coins: number; expiresAt?: number; totalLimit?: number; note?: string },
    ): Promise<{ code: string }> {
      if (!this.promo.available) throw new AdminError(503, 'promo_unavailable', 'commercial not configured');
      const r = await this.promo.create({ ...args, createdBy: actor.adminId });
      await this.audit(actor.adminId, 'promo.create', { target: r.code, summary: `${args.coins} coins` });
      return r;
    }
  };
}
