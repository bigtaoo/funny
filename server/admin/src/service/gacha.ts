// Custom gacha pool management (GACHA_DESIGN §12, gacha.pools.manage). Proxies the meta gacha-pools store + audit.
import { catalogByCategory, type CustomPoolConfig, type GachaCategory, type GachaCatalogItem } from '@nw/shared';
import type { AdminGachaPool } from '../clients';
import type { Actor, AdminCore } from './base';
import { AdminError } from './errors';

export interface GachaHandlers {
  listGachaPools(): Promise<AdminGachaPool[]>;
  gachaCatalog(): Promise<Record<GachaCategory, GachaCatalogItem[]>>;
  createCustomPool(actor: Actor, config: CustomPoolConfig): Promise<{ id: string }>;
  closeGachaPool(actor: Actor, id: string): Promise<{ id: string }>;
}

export class GachaService {
  constructor(private readonly core: AdminCore) {}

    // ───────────────────── Custom gacha pool management (GACHA_DESIGN §12, gacha.pools.manage) ────────
    /** List all stored gacha pool configs (derived + custom). Returns empty if meta is unreachable. */
    async listGachaPools(): Promise<AdminGachaPool[]> {
      if (!this.core.gachaPools.available) return [];
      return this.core.gachaPools.list();
    }

    /**
     * The item catalogue (grouped by category) an operator may place in a custom pool. comm-audit batch F
     * item 10: this is a pure function over @nw/shared's static GACHA_CATALOG — compute it locally instead
     * of round-tripping to meta (which also removes a spurious 503 whenever meta happens to be unreachable).
     */
    async gachaCatalog(): Promise<Record<GachaCategory, GachaCatalogItem[]>> {
      return catalogByCategory();
    }

    /** Create/replace an ops-authored custom pool; meta-side validation failure throws EventsClientError (httpApi → 4xx). Audited. */
    async createCustomPool(actor: Actor, config: CustomPoolConfig): Promise<{ id: string }> {
      if (!this.core.gachaPools.available) throw new AdminError(503, 'gacha_unavailable', 'meta not configured');
      const r = await this.core.gachaPools.createCustom(config, actor.adminId);
      await this.core.audit(actor.adminId, 'gacha.pool.create', { target: r.id, summary: config.name });
      return r;
    }

    /** Close a gacha pool early (clamp its window to now). Audited. */
    async closeGachaPool(actor: Actor, id: string): Promise<{ id: string }> {
      if (!this.core.gachaPools.available) throw new AdminError(503, 'gacha_unavailable', 'meta not configured');
      const r = await this.core.gachaPools.close(id);
      await this.core.audit(actor.adminId, 'gacha.pool.close', { target: r.id });
      return r;
    }
}
