// Custom gacha pool management (GACHA_DESIGN §12, gacha.pools.manage). Proxies the meta gacha-pools store + audit.
import type { CustomPoolConfig, GachaCategory, GachaCatalogItem } from '@nw/shared';
import type { AdminGachaPool } from '../clients';
import type { Actor, AdminBaseCtor, Constructor } from './base';
import { AdminError } from './errors';

export interface GachaHandlers {
  listGachaPools(): Promise<AdminGachaPool[]>;
  gachaCatalog(): Promise<Record<GachaCategory, GachaCatalogItem[]>>;
  createCustomPool(actor: Actor, config: CustomPoolConfig): Promise<{ id: string }>;
  closeGachaPool(actor: Actor, id: string): Promise<{ id: string }>;
}

export function GachaMixin<TBase extends AdminBaseCtor>(Base: TBase): TBase & Constructor<GachaHandlers> {
  return class extends Base {
    // ───────────────────── Custom gacha pool management (GACHA_DESIGN §12, gacha.pools.manage) ────────
    /** List all stored gacha pool configs (derived + custom). Returns empty if meta is unreachable. */
    async listGachaPools(): Promise<AdminGachaPool[]> {
      if (!this.gachaPools.available) return [];
      return this.gachaPools.list();
    }

    /** The item catalogue (grouped by category) an operator may place in a custom pool. */
    async gachaCatalog(): Promise<Record<GachaCategory, GachaCatalogItem[]>> {
      if (!this.gachaPools.available) throw new AdminError(503, 'gacha_unavailable', 'meta not configured');
      return this.gachaPools.catalog();
    }

    /** Create/replace an ops-authored custom pool; meta-side validation failure throws EventsClientError (httpApi → 4xx). Audited. */
    async createCustomPool(actor: Actor, config: CustomPoolConfig): Promise<{ id: string }> {
      if (!this.gachaPools.available) throw new AdminError(503, 'gacha_unavailable', 'meta not configured');
      const r = await this.gachaPools.createCustom(config, actor.adminId);
      await this.audit(actor.adminId, 'gacha.pool.create', { target: r.id, summary: config.name });
      return r;
    }

    /** Close a gacha pool early (clamp its window to now). Audited. */
    async closeGachaPool(actor: Actor, id: string): Promise<{ id: string }> {
      if (!this.gachaPools.available) throw new AdminError(503, 'gacha_unavailable', 'meta not configured');
      const r = await this.gachaPools.close(id);
      await this.audit(actor.adminId, 'gacha.pool.close', { target: r.id });
      return r;
    }
  };
}
