import { fetchInternalJson, type ReportCategory, type ReportChannel } from '@nw/shared';
import { log } from './shared';

// ── UGC report review queue (socialsvc /internal/reports, CONTENT_MODERATION_DESIGN.md CM9/CM11) ──────────
/** Report record view (mirror of socialsvc's ReportDoc; that type is intentionally local to socialsvc/src/db.ts
 *  — decoupled from @nw/shared — so this is a hand-mirrored shape, same as AntiCheatReviewRow mirrors meta's doc). */
export interface ReportRow {
  _id: string;
  reporterId: string;
  targetId: string;
  reason: string;
  ts: number;
  status: 'open' | 'dismissed' | 'upheld';
  /** Guideline 1.2 taxonomy; absent on older reports. */
  category?: ReportCategory;
  /** 'block' = auto-filed when the reporter blocked the target; absent on older reports (= 'report'). */
  source?: 'report' | 'block';
  contentRef?:
    | { kind: 'content'; channel: ReportChannel; messageId?: string; snapshot?: string; snapshotSource?: 'server' | 'client' }
    | { kind: 'message'; conversationId: string; messageId: string }
    | { kind: 'name'; snapshot: string };
  resolvedBy?: string;
  resolvedAt?: number;
}

export interface ReportsClient {
  readonly available: boolean;
  /** List reports (defaults to open status); returns empty array if unavailable or on error. */
  listReports(opts?: { status?: string; limit?: number }): Promise<ReportRow[]>;
  /** Resolve a report's own status. Does not touch reputationScore — see AdminService.resolveReport, which
   *  additionally calls the metaserver penalty endpoint on 'upheld' (CM7's single enforcement path). */
  resolveReport(id: string, resolution: 'dismissed' | 'upheld', resolvedBy: string): Promise<{ ok: boolean }>;
}

export class HttpReportsClient implements ReportsClient {
  constructor(
    private readonly socialBaseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.socialBaseUrl !== null;
  }

  async listReports(opts?: { status?: string; limit?: number }): Promise<ReportRow[]> {
    if (!this.socialBaseUrl) return [];
    const qs = new URLSearchParams();
    if (opts?.status) qs.set('status', opts.status);
    if (opts?.limit) qs.set('limit', String(opts.limit));
    // socialsvc wraps every reply in the ApiResp envelope ({ ok, data }). This used to read `body.reports`,
    // which is always undefined on the real service, so the ops queue rendered empty in every deployment —
    // only the fetch-mocked unit test ever saw rows (found 2026-09-29 while wiring Guideline 1.2 alerts).
    const r = await fetchInternalJson<{ data?: { reports?: ReportRow[] } }>(`${this.socialBaseUrl}/internal/reports?${qs}`, {
      caller: 'admin',
      key: this.internalKey,
      timeoutMs: 10000,
      log,
      label: 'social /internal/reports',
    });
    if (!r.ok || !r.body) return [];
    return r.body.data?.reports ?? [];
  }

  async resolveReport(id: string, resolution: 'dismissed' | 'upheld', resolvedBy: string): Promise<{ ok: boolean }> {
    if (!this.socialBaseUrl) return { ok: false };
    const r = await fetchInternalJson<{ ok?: boolean }>(`${this.socialBaseUrl}/internal/reports/${encodeURIComponent(id)}/resolve`, {
      caller: 'admin',
      key: this.internalKey,
      method: 'POST',
      body: { resolution, resolvedBy },
      timeoutMs: 10000,
      log,
      label: 'social /internal/reports/:id/resolve',
    });
    return { ok: r.ok };
  }
}
