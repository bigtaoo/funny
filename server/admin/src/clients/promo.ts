import { fetchInternalJson } from '@nw/shared';
import { EventsClientError } from './events';

// ── Promo code client (B-PROMO) ────────────────────────────

export interface PromoCodeView {
  code: string;
  coins: number;
  expiresAt?: number;
  totalLimit?: number;
  redeemed: number;
  note?: string;
  createdBy: string;
  createdAt: number;
}

export interface PromoClient {
  readonly available: boolean;
  list(): Promise<PromoCodeView[]>;
  create(args: { code: string; coins: number; expiresAt?: number; totalLimit?: number; note?: string; createdBy: string }): Promise<{ code: string }>;
}

export class HttpPromoClient implements PromoClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean { return this.metaBaseUrl !== null; }

  async list(): Promise<PromoCodeView[]> {
    if (!this.metaBaseUrl) return [];
    const r = await fetchInternalJson<{ codes?: PromoCodeView[] }>(`${this.metaBaseUrl}/admin/promo/codes`, {
      caller: 'admin',
      key: this.internalKey,
      timeoutMs: 10000,
      label: 'meta GET /admin/promo/codes',
    });
    if (!r.ok) throw new EventsClientError(r.status || 502, `list promo codes ${r.status ? `HTTP ${r.status}` : r.error ?? 'network error'}`);
    return r.body?.codes ?? [];
  }

  async create(args: { code: string; coins: number; expiresAt?: number; totalLimit?: number; note?: string; createdBy: string }): Promise<{ code: string }> {
    if (!this.metaBaseUrl) throw new EventsClientError(503, 'meta not configured');
    const r = await fetchInternalJson<{ code?: string; error?: string }>(`${this.metaBaseUrl}/admin/promo/codes`, {
      caller: 'admin',
      key: this.internalKey,
      method: 'POST',
      body: args,
      timeoutMs: 10000,
      label: 'meta POST /admin/promo/codes',
    });
    if (!r.ok || !r.body?.code) {
      throw new EventsClientError(r.status || 502, r.body?.error ?? r.error ?? `create promo code HTTP ${r.status}`);
    }
    return { code: r.body.code };
  }
}
