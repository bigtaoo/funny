import { fetchInternalJson, type CustomPoolConfig, type GachaCatalogItem, type GachaCategory } from '@nw/shared';
import { EventsClientError } from './events';

// ── Custom gacha pool management (meta /admin/gacha/*, GACHA_DESIGN §12, gacha.pools.manage) ────────
/** A pool config as listed by meta/commercial (derived §2.2 or custom §12; discriminated by `kind`). */
export interface AdminGachaPool {
  id: string;
  name: string;
  startAt: number;
  endAt: number;
  kind?: 'derived' | 'custom';
  // derived pools
  featuredLegendary?: string;
  // custom pools (§12)
  costSingle?: number;
  costTen?: number;
  categories?: CustomPoolConfig['categories'];
  createdBy: string;
  createdAt: number;
  closedAt?: number;
}

export interface GachaPoolsClient {
  readonly available: boolean;
  list(): Promise<AdminGachaPool[]>;
  catalog(): Promise<Record<GachaCategory, GachaCatalogItem[]>>;
  createCustom(config: CustomPoolConfig, createdBy: string): Promise<{ id: string }>;
  close(id: string): Promise<{ id: string }>;
}

export class HttpGachaPoolsClient implements GachaPoolsClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean { return this.metaBaseUrl !== null; }

  async list(): Promise<AdminGachaPool[]> {
    if (!this.metaBaseUrl) return [];
    const r = await fetchInternalJson<{ pools?: AdminGachaPool[] }>(`${this.metaBaseUrl}/admin/gacha/pools`, {
      caller: 'admin',
      key: this.internalKey,
      timeoutMs: 10000,
      label: 'meta /admin/gacha/pools',
    });
    if (!r.ok) throw new EventsClientError(r.status || 502, `list gacha pools ${r.status ? `HTTP ${r.status}` : r.error ?? 'network error'}`);
    return r.body?.pools ?? [];
  }

  async catalog(): Promise<Record<GachaCategory, GachaCatalogItem[]>> {
    if (!this.metaBaseUrl) throw new EventsClientError(503, 'meta not configured');
    const r = await fetchInternalJson<{ catalog?: Record<GachaCategory, GachaCatalogItem[]>; error?: string }>(`${this.metaBaseUrl}/admin/gacha/catalog`, {
      caller: 'admin',
      key: this.internalKey,
      timeoutMs: 10000,
      label: 'meta /admin/gacha/catalog',
    });
    if (!r.ok || !r.body?.catalog) throw new EventsClientError(r.status || 502, r.body?.error ?? r.error ?? `catalog HTTP ${r.status}`);
    return r.body.catalog;
  }

  async createCustom(config: CustomPoolConfig, createdBy: string): Promise<{ id: string }> {
    if (!this.metaBaseUrl) throw new EventsClientError(503, 'meta not configured');
    const r = await fetchInternalJson<{ id?: string; detail?: string; error?: string }>(`${this.metaBaseUrl}/admin/gacha/pools/custom`, {
      caller: 'admin',
      key: this.internalKey,
      method: 'POST',
      body: { ...config, createdBy },
      timeoutMs: 10000,
      label: 'meta /admin/gacha/pools/custom',
    });
    if (!r.ok || !r.body?.id) throw new EventsClientError(r.status || 502, r.body?.detail ?? r.body?.error ?? r.error ?? `create pool HTTP ${r.status}`);
    return { id: r.body.id };
  }

  async close(id: string): Promise<{ id: string }> {
    if (!this.metaBaseUrl) throw new EventsClientError(503, 'meta not configured');
    const r = await fetchInternalJson<{ id?: string; error?: string }>(`${this.metaBaseUrl}/admin/gacha/pools/close`, {
      caller: 'admin',
      key: this.internalKey,
      method: 'POST',
      body: { id },
      timeoutMs: 10000,
      label: 'meta /admin/gacha/pools/close',
    });
    if (!r.ok || !r.body?.id) throw new EventsClientError(r.status || 502, r.body?.error ?? r.error ?? `close pool HTTP ${r.status}`);
    return { id: r.body.id };
  }
}
