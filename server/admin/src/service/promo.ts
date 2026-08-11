// Promo code management (B-PROMO, promo.manage). Proxies the commercial promo store + audit.
import type { PromoCodeView } from '../clients';
import type { Actor, AdminCore } from './base';
import { AdminError } from './errors';

export interface PromoHandlers {
  listPromoCodes(): Promise<PromoCodeView[]>;
  createPromoCode(
    actor: Actor,
    args: { code: string; coins: number; expiresAt?: number; totalLimit?: number; note?: string },
  ): Promise<{ code: string }>;
}

export class PromoService {
  constructor(private readonly core: AdminCore) {}

    // ───────────────────── Promo code management (B-PROMO, promo.manage) ──────────────────────────
    /** List all promo codes; returns an empty list if commercial is unreachable. */
    async listPromoCodes(): Promise<PromoCodeView[]> {
      if (!this.core.promo.available) return [];
      return this.core.promo.list();
    }

    /** Create a promo code. Audited. Throws AdminError if commercial is unreachable or the code already exists. */
    async createPromoCode(
      actor: Actor,
      args: { code: string; coins: number; expiresAt?: number; totalLimit?: number; note?: string },
    ): Promise<{ code: string }> {
      if (!this.core.promo.available) throw new AdminError(503, 'promo_unavailable', 'commercial not configured');
      const r = await this.core.promo.create({ ...args, createdBy: actor.adminId });
      await this.core.audit(actor.adminId, 'promo.create', { target: r.code, summary: `${args.coins} coins` });
      return r;
    }
}
