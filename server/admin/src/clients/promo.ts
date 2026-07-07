import { internalHeaders } from '@nw/shared';
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
    const res = await fetch(`${this.metaBaseUrl}/admin/promo/codes`, {
      headers: internalHeaders('admin', this.internalKey),
    });
    if (!res.ok) throw new EventsClientError(res.status, `list promo codes HTTP ${res.status}`);
    const body = (await res.json()) as { codes?: PromoCodeView[] };
    return body.codes ?? [];
  }

  async create(args: { code: string; coins: number; expiresAt?: number; totalLimit?: number; note?: string; createdBy: string }): Promise<{ code: string }> {
    if (!this.metaBaseUrl) throw new EventsClientError(503, 'meta not configured');
    const res = await fetch(`${this.metaBaseUrl}/admin/promo/codes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('admin', this.internalKey) },
      body: JSON.stringify(args),
    });
    const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
    if (!res.ok || !body.code) {
      throw new EventsClientError(res.status, body.error ?? `create promo code HTTP ${res.status}`);
    }
    return { code: body.code };
  }
}
