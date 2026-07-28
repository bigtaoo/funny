import { fetchInternalJson, type AntiCheatReviewDoc } from '@nw/shared';
import { log } from './shared';

// ── Achievement anti-cheat review queue (meta /internal/anticheat/reviews, S9-7) ──────────────
/** Review record view (= meta AntiCheatReviewDoc, read-only display in OPS). */
export type AntiCheatReviewRow = AntiCheatReviewDoc;

export interface AntiCheatClient {
  readonly available: boolean;
  /** List anti-cheat review records (defaults to open status); returns empty array if unavailable or on error. */
  listReviews(opts?: { accountId?: string; status?: string; limit?: number }): Promise<AntiCheatReviewRow[]>;
  /** Mark a review record resolved (does not itself ban — see AdminService.resolveAntiCheatReview). */
  resolveReview(id: string, resolution: 'dismissed' | 'banned', resolvedBy: string): Promise<{ ok: boolean }>;
}

export class HttpAntiCheatClient implements AntiCheatClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.metaBaseUrl !== null;
  }

  async listReviews(opts?: { accountId?: string; status?: string; limit?: number }): Promise<AntiCheatReviewRow[]> {
    if (!this.metaBaseUrl) return [];
    const qs = new URLSearchParams();
    if (opts?.accountId) qs.set('accountId', opts.accountId);
    if (opts?.status) qs.set('status', opts.status);
    if (opts?.limit) qs.set('limit', String(opts.limit));
    // Degrades to [] on any failure (network / timeout / non-2xx), as before.
    const r = await fetchInternalJson<{ reviews?: AntiCheatReviewRow[] }>(`${this.metaBaseUrl}/internal/anticheat/reviews?${qs}`, {
      caller: 'admin',
      key: this.internalKey,
      timeoutMs: 10000,
      log,
      label: 'meta /internal/anticheat/reviews',
    });
    if (!r.ok || !r.body) return [];
    return r.body.reviews ?? [];
  }

  async resolveReview(id: string, resolution: 'dismissed' | 'banned', resolvedBy: string): Promise<{ ok: boolean }> {
    if (!this.metaBaseUrl) return { ok: false };
    // Failure (network / non-2xx) reports {ok:false}, as before.
    const r = await fetchInternalJson<{ ok?: boolean }>(`${this.metaBaseUrl}/internal/anticheat/reviews/${encodeURIComponent(id)}/resolve`, {
      caller: 'admin',
      key: this.internalKey,
      method: 'POST',
      body: { resolution, resolvedBy },
      timeoutMs: 10000,
      log,
      label: 'meta /internal/anticheat/reviews/:id/resolve',
    });
    return { ok: r.ok };
  }
}
