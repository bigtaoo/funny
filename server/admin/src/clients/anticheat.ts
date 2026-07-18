import { internalHeaders, type AntiCheatReviewDoc } from '@nw/shared';
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
    try {
      const qs = new URLSearchParams();
      if (opts?.accountId) qs.set('accountId', opts.accountId);
      if (opts?.status) qs.set('status', opts.status);
      if (opts?.limit) qs.set('limit', String(opts.limit));
      const res = await fetch(`${this.metaBaseUrl}/internal/anticheat/reviews?${qs}`, {
        headers: internalHeaders('admin', this.internalKey),
      });
      if (!res.ok) {
        log.warn('anticheat reviews non-2xx', { status: res.status });
        return [];
      }
      const body = (await res.json()) as { reviews?: AntiCheatReviewRow[] };
      return body.reviews ?? [];
    } catch (e) {
      log.warn('anticheat reviews failed', { err: (e as Error).message });
      return [];
    }
  }

  async resolveReview(id: string, resolution: 'dismissed' | 'banned', resolvedBy: string): Promise<{ ok: boolean }> {
    if (!this.metaBaseUrl) return { ok: false };
    try {
      const res = await fetch(`${this.metaBaseUrl}/internal/anticheat/reviews/${encodeURIComponent(id)}/resolve`, {
        method: 'POST',
        headers: { ...internalHeaders('admin', this.internalKey), 'content-type': 'application/json' },
        body: JSON.stringify({ resolution, resolvedBy }),
      });
      return { ok: res.ok };
    } catch (e) {
      log.warn('resolve anticheat review failed', { err: (e as Error).message });
      return { ok: false };
    }
  }
}
