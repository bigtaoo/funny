import { fetchInternalJson } from '@nw/shared';
import { EventsClientError } from './events';

// ── Paddle webhook event log client (support/CS lookup, COMMERCIAL_DESIGN §10.4) ────────────────────────────

export interface PaddleEventView {
  transactionId: string;
  eventType: string;
  status?: string;
  accountId?: string;
  rawEvent: string;
  ts: number;
}

export interface PaddleEventsClient {
  readonly available: boolean;
  list(args: { accountId?: string; transactionId?: string; limit?: number }): Promise<PaddleEventView[]>;
}

export class HttpPaddleEventsClient implements PaddleEventsClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean { return this.metaBaseUrl !== null; }

  async list(args: { accountId?: string; transactionId?: string; limit?: number }): Promise<PaddleEventView[]> {
    if (!this.metaBaseUrl) return [];
    const q = new URLSearchParams();
    if (args.accountId) q.set('accountId', args.accountId);
    if (args.transactionId) q.set('transactionId', args.transactionId);
    if (args.limit) q.set('limit', String(args.limit));
    const r = await fetchInternalJson<{ events?: PaddleEventView[] }>(`${this.metaBaseUrl}/admin/paddle/events?${q}`, {
      caller: 'admin',
      key: this.internalKey,
      timeoutMs: 10000,
      label: 'meta /admin/paddle/events',
    });
    if (!r.ok) throw new EventsClientError(r.status || 502, `list paddle events ${r.status ? `HTTP ${r.status}` : r.error ?? 'network error'}`);
    return r.body?.events ?? [];
  }
}
