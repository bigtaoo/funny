// SLG season ops (G7/§17.7). Proxies worldsvc /admin/world/* + audit + operational sequence constraint
// (must settle before reset, to prevent loss of history).
import type { SlgWorldSummary } from '../clients';
import type { AdminBaseCtor, Constructor } from './base';
import { AdminError } from './errors';

export interface WorldHandlers {
  slgListWorlds(): Promise<SlgWorldSummary[]>;
  slgOpenSeason(actor: string, worldId: string, season: number, shard: number, capacity: number): Promise<void>;
  slgSettleSeason(actor: string, worldId: string): Promise<unknown>;
  slgResetSeason(actor: string, worldId: string): Promise<unknown>;
  slgCloseSeason(actor: string, worldId: string): Promise<void>;
  slgMergeShard(actor: string, worldId: string, targetWorldId: string): Promise<{ moved: number; failed: string[] }>;
}

export function WorldMixin<TBase extends AdminBaseCtor>(Base: TBase): TBase & Constructor<WorldHandlers> {
  return class extends Base {
    // ───────────────────── SLG season ops (G7/§17.7) ─────────────────────
    // Proxies worldsvc /admin/world/* + audit + operational sequence constraint (must settle before reset, to prevent loss of history).

    /** List operational summaries for all worlds (capability slg.season.view). Returns empty if worldsvc is unreachable. */
    async slgListWorlds(): Promise<SlgWorldSummary[]> {
      if (!this.world.available) return [];
      return this.world.listWorlds();
    }

    /** Open a new world (high-risk, super only). Audited. */
    async slgOpenSeason(actor: string, worldId: string, season: number, shard: number, capacity: number): Promise<void> {
      await this.world.openWorld(worldId, season, shard, capacity);
      await this.audit(actor, 'slg.season.open', { target: worldId, summary: `s${season}-${shard} cap=${capacity}` });
    }

    /** Settle a world (persist seasonResults + distribute rewards). Audited. */
    async slgSettleSeason(actor: string, worldId: string): Promise<unknown> {
      const r = await this.world.settleWorld(worldId);
      await this.audit(actor, 'slg.season.settle', { target: worldId });
      return r;
    }

    /**
     * Reset a world (wipe data and reopen, high-risk). Operational sequence constraint: the world must have already
     * been settled (status=settling/resetting) before reset is allowed; otherwise the request is rejected
     * (prevents skipping settlement and losing seasonResults history, §17.7). worldsvc enforces the same guard (double safety net).
     */
    async slgResetSeason(actor: string, worldId: string): Promise<unknown> {
      const worlds = await this.world.listWorlds();
      const w = worlds.find((x) => x.worldId === worldId);
      if (w && w.status !== 'settling' && w.status !== 'resetting') {
        throw new AdminError(409, 'conflict', `must settle before reset (current status=${w.status}, expected settling)`);
      }
      const r = await this.world.resetWorld(worldId);
      await this.audit(actor, 'slg.season.reset', { target: worldId });
      return r;
    }

    /** Close a world (archive it). Audited. */
    async slgCloseSeason(actor: string, worldId: string): Promise<void> {
      await this.world.closeWorld(worldId);
      await this.audit(actor, 'slg.season.close', { target: worldId });
    }

    /**
     * Merge a low-population shard (G6/§27, high-risk): moves every remaining player out of `worldId`
     * (source) into `targetWorldId`, then closes `worldId`. Best-effort per player — `failed` lists accounts
     * that could not be moved (logged server-side, left in the closing shard). Audited with the move count.
     */
    async slgMergeShard(actor: string, worldId: string, targetWorldId: string): Promise<{ moved: number; failed: string[] }> {
      const r = await this.world.mergeWorld(worldId, targetWorldId);
      await this.audit(actor, 'slg.season.merge', { target: worldId, summary: `→${targetWorldId} moved=${r.moved} failed=${r.failed.length}` });
      return r;
    }
  };
}
