import { internalHeaders } from '@nw/shared';
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
    const res = await fetch(`${this.metaBaseUrl}/admin/paddle/events?${q}`, {
      headers: internalHeaders('admin', this.internalKey),
    });
    if (!res.ok) throw new EventsClientError(res.status, `list paddle events HTTP ${res.status}`);
    const body = (await res.json()) as { events?: PaddleEventView[] };
    return body.events ?? [];
  }
}
