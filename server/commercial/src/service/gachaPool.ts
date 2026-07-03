// Limited/custom gacha pool config CRUD (GACHA_DESIGN §2.2 / §12). Admin-authored pools live in the
// `gachaPools` collection alongside derived pools, discriminated by `kind:'custom'`.
import { findGachaPool, validateCustomPool, type LimitedPoolConfig, type CustomPoolConfig } from '@nw/shared';
import type { GachaPoolDoc, CustomGachaPoolDoc } from '../db';
import { isLimitedPoolActive } from '@nw/shared';
import type { CommercialBaseCtor, Constructor, Result } from './base';

export interface GachaPoolHandlers {
  createLimitedPool(args: { config: LimitedPoolConfig; createdBy: string }): Promise<Result<{ id: string }>>;
  createCustomPool(args: { config: CustomPoolConfig; createdBy: string }): Promise<Result<{ id: string }>>;
  closeLimitedPool(args: { id: string }): Promise<Result<{ id: string }>>;
  listLimitedPools(): Promise<GachaPoolDoc[]>;
  listActiveLimitedPools(now: number): Promise<GachaPoolDoc[]>;
}

export function GachaPoolMixin<TBase extends CommercialBaseCtor>(Base: TBase): TBase & Constructor<GachaPoolHandlers> {
  return class extends Base {
    /** Create (or overwrite) a limited pool config (admin, GACHA_DESIGN §2.2). */
    async createLimitedPool(args: {
      config: LimitedPoolConfig;
      createdBy: string;
    }): Promise<Result<{ id: string }>> {
      const c = args.config;
      if (!c.id || !c.name || !c.featuredLegendary) return { ok: false, error: 'BAD_REQUEST' };
      if (!(c.endAt > c.startAt)) return { ok: false, error: 'BAD_REQUEST' };
      if (findGachaPool(c.id)) return { ok: false, error: 'BAD_REQUEST' }; // must not shadow a static pool id
      const doc: GachaPoolDoc = {
        _id: c.id,
        id: c.id,
        name: c.name,
        featuredLegendary: c.featuredLegendary,
        startAt: c.startAt,
        endAt: c.endAt,
        ...(c.fillerLegendaries ? { fillerLegendaries: c.fillerLegendaries } : {}),
        createdBy: args.createdBy,
        createdAt: this.now(),
      };
      await this.cols.gachaPools.replaceOne({ _id: c.id }, doc, { upsert: true });
      return { ok: true, id: c.id };
    }

    /**
     * Create (or overwrite) an ops-authored custom pool config (GACHA_DESIGN §12). Validates the config,
     * refuses to shadow a static pool id, and preserves createdBy/createdAt across edits. Shares the
     * `gachaPools` collection with derived pools, discriminated by `kind:'custom'`.
     */
    async createCustomPool(args: {
      config: CustomPoolConfig;
      createdBy: string;
    }): Promise<Result<{ id: string }>> {
      const c = args.config;
      if (validateCustomPool(c) !== null) return { ok: false, error: 'BAD_REQUEST' };
      if (findGachaPool(c.id)) return { ok: false, error: 'BAD_REQUEST' }; // must not shadow a static pool id
      const prev = await this.cols.gachaPools.findOne({ _id: c.id });
      const doc: CustomGachaPoolDoc = {
        _id: c.id,
        kind: 'custom',
        id: c.id,
        name: c.name,
        costSingle: c.costSingle,
        ...(c.costTen != null ? { costTen: c.costTen } : {}),
        startAt: c.startAt,
        endAt: c.endAt,
        categories: c.categories,
        createdBy: prev?.createdBy ?? args.createdBy,
        createdAt: prev?.createdAt ?? this.now(),
      };
      await this.cols.gachaPools.replaceOne({ _id: c.id }, doc, { upsert: true });
      return { ok: true, id: c.id };
    }

    /** Close a limited pool early (clamp endAt to now); the config is retained so its featured legendary stays Fate-redeemable. */
    async closeLimitedPool(args: { id: string }): Promise<Result<{ id: string }>> {
      const now = this.now();
      const res = await this.cols.gachaPools.findOneAndUpdate(
        { _id: args.id },
        { $set: { endAt: now, closedAt: now } },
      );
      if (!res) return { ok: false, error: 'NOT_FOUND' };
      return { ok: true, id: args.id };
    }

    /** List all limited pool configs (admin management). */
    async listLimitedPools(): Promise<GachaPoolDoc[]> {
      return this.cols.gachaPools.find({}).sort({ createdAt: -1 }).toArray();
    }

    /** List currently-open limited pool configs (for the client gacha listing). */
    async listActiveLimitedPools(now: number): Promise<GachaPoolDoc[]> {
      return (await this.cols.gachaPools.find({}).toArray()).filter((p) => isLimitedPoolActive(p, now));
    }
  };
}
