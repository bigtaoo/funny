import { fetchInternalJson } from '@nw/shared';
import { log } from './shared';

// ── Player appeals against an active enforcement (metaserver /internal/appeals, CONTENT_MODERATION_DESIGN.md CM10) ──
/** Appeal record view (mirror of metaserver's AppealDoc). */
export interface AppealRow {
  _id: string;
  accountId: string;
  publicId?: string;
  reason: string;
  enforcementSnapshot: { banned?: boolean; bannedUntil?: number; mutedUntil?: number; reputationScore?: number };
  status: 'open' | 'approved' | 'denied';
  createdAt: number;
  resolvedBy?: string;
  resolvedAt?: number;
  resolutionNote?: string;
}

export interface AppealsClient {
  readonly available: boolean;
  /** List appeals (defaults to open status); returns empty array if unavailable or on error. */
  listAppeals(opts?: { status?: string; limit?: number }): Promise<AppealRow[]>;
  /** Approve clears the account's current enforcement fields (not reputationScore, see CM10); deny just stamps the record. */
  resolveAppeal(
    id: string,
    resolution: 'approved' | 'denied',
    resolvedBy: string,
    note?: string,
  ): Promise<{ ok: boolean }>;
}

export class HttpAppealsClient implements AppealsClient {
  constructor(
    private readonly metaBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.metaBaseUrl !== null;
  }

  async listAppeals(opts?: { status?: string; limit?: number }): Promise<AppealRow[]> {
    if (!this.metaBaseUrl) return [];
    const qs = new URLSearchParams();
    if (opts?.status) qs.set('status', opts.status);
    if (opts?.limit) qs.set('limit', String(opts.limit));
    const r = await fetchInternalJson<{ appeals?: AppealRow[] }>(`${this.metaBaseUrl}/internal/appeals?${qs}`, {
      caller: 'admin',
      key: this.internalKey,
      timeoutMs: 10000,
      log,
      label: 'meta /internal/appeals',
    });
    if (!r.ok || !r.body) return [];
    return r.body.appeals ?? [];
  }

  async resolveAppeal(
    id: string,
    resolution: 'approved' | 'denied',
    resolvedBy: string,
    note?: string,
  ): Promise<{ ok: boolean }> {
    if (!this.metaBaseUrl) return { ok: false };
    const r = await fetchInternalJson<{ ok?: boolean }>(`${this.metaBaseUrl}/internal/appeals/${encodeURIComponent(id)}/resolve`, {
      caller: 'admin',
      key: this.internalKey,
      method: 'POST',
      body: { resolution, resolvedBy, ...(note ? { note } : {}) },
      timeoutMs: 10000,
      log,
      label: 'meta /internal/appeals/:id/resolve',
    });
    return { ok: r.ok };
  }
}
