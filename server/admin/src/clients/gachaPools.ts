import { internalHeaders, type CustomPoolConfig, type GachaCatalogItem, type GachaCategory } from '@nw/shared';
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
    const res = await fetch(`${this.metaBaseUrl}/admin/gacha/pools`, {
      headers: internalHeaders('admin', this.internalKey),
    });
    if (!res.ok) throw new EventsClientError(res.status, `list gacha pools HTTP ${res.status}`);
    const body = (await res.json()) as { pools?: AdminGachaPool[] };
    return body.pools ?? [];
  }

  async catalog(): Promise<Record<GachaCategory, GachaCatalogItem[]>> {
    if (!this.metaBaseUrl) throw new EventsClientError(503, 'meta not configured');
    const res = await fetch(`${this.metaBaseUrl}/admin/gacha/catalog`, {
      headers: internalHeaders('admin', this.internalKey),
    });
    const body = (await res.json().catch(() => ({}))) as { catalog?: Record<GachaCategory, GachaCatalogItem[]>; error?: string };
    if (!res.ok || !body.catalog) throw new EventsClientError(res.status, body.error ?? `catalog HTTP ${res.status}`);
    return body.catalog;
  }

  async createCustom(config: CustomPoolConfig, createdBy: string): Promise<{ id: string }> {
    if (!this.metaBaseUrl) throw new EventsClientError(503, 'meta not configured');
    const res = await fetch(`${this.metaBaseUrl}/admin/gacha/pools/custom`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('admin', this.internalKey) },
      body: JSON.stringify({ ...config, createdBy }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; detail?: string; error?: string };
    if (!res.ok || !body.id) throw new EventsClientError(res.status, body.detail ?? body.error ?? `create pool HTTP ${res.status}`);
    return { id: body.id };
  }

  async close(id: string): Promise<{ id: string }> {
    if (!this.metaBaseUrl) throw new EventsClientError(503, 'meta not configured');
    const res = await fetch(`${this.metaBaseUrl}/admin/gacha/pools/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('admin', this.internalKey) },
      body: JSON.stringify({ id }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
    if (!res.ok || !body.id) throw new EventsClientError(res.status, body.error ?? `close pool HTTP ${res.status}`);
    return { id: body.id };
  }
}
