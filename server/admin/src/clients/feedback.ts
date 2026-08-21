import { fetchInternalJson } from '@nw/shared';
import { log } from './shared';

// ── Player feedback (metaserver /internal/feedback, UI_DESIGN.md §4.1.1 / SERVER_API.md §2.13) ──
/**
 * Feedback record view (mirror of metaserver's FeedbackDoc). No status machine/verdict, but a lightweight
 * triage trail (feedback.action): `readAt` stamped on the first review call and never overwritten (unread
 * ⟺ `!readAt`), `readBy`/`note` last-write-wins.
 */
export interface FeedbackRow {
  _id: string;
  accountId: string;
  text: string;
  clientPlatform?: string;
  createdAt: number;
  readAt?: number;
  readBy?: string;
  note?: string;
}

export interface FeedbackClient {
  readonly available: boolean;
  /** List feedback, newest first; returns empty array if unavailable or on error. */
  listFeedback(opts?: { limit?: number }): Promise<FeedbackRow[]>;
  /** Mark a row read and/or attach a note (feedback.action). `note` omitted leaves an existing note intact; `''` clears it. */
  reviewFeedback(id: string, readBy: string, note?: string): Promise<{ ok: boolean }>;
}

export class HttpFeedbackClient implements FeedbackClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.metaBaseUrl !== null;
  }

  async listFeedback(opts?: { limit?: number }): Promise<FeedbackRow[]> {
    if (!this.metaBaseUrl) return [];
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set('limit', String(opts.limit));
    const r = await fetchInternalJson<{ feedback?: FeedbackRow[] }>(`${this.metaBaseUrl}/internal/feedback?${qs}`, {
      caller: 'admin',
      key: this.internalKey,
      timeoutMs: 10000,
      log,
      label: 'meta /internal/feedback',
    });
    if (!r.ok || !r.body) return [];
    return r.body.feedback ?? [];
  }

  async reviewFeedback(id: string, readBy: string, note?: string): Promise<{ ok: boolean }> {
    if (!this.metaBaseUrl) return { ok: false };
    const r = await fetchInternalJson<{ ok?: boolean }>(`${this.metaBaseUrl}/internal/feedback/${encodeURIComponent(id)}/review`, {
      caller: 'admin',
      key: this.internalKey,
      method: 'POST',
      body: { readBy, ...(note !== undefined ? { note } : {}) },
      timeoutMs: 10000,
      log,
      label: 'meta /internal/feedback/:id/review',
    });
    return { ok: r.ok && !!r.body?.ok };
  }
}
