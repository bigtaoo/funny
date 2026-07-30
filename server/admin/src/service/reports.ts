// UGC report review queue (CONTENT_MODERATION_DESIGN.md CM9/CM11): admin is the "processing hub" — it
// resolves the report itself (socialsvc) and, on 'upheld', separately calls the metaserver penalty
// endpoint (CM7's single enforcement path) in the same operation. Two calls, best-effort (no distributed
// transaction, same pragmatic choice as TradeAuditTicketView's auto-ban — see slgAudit.ts).
import type { ReportRow } from '../clients';
import type { Actor, AdminBaseCtor, Constructor } from './base';
import { AdminError } from './errors';

/** Reputation delta applied per upheld report (user-confirmed 2026-07-29, CONTENT_MODERATION_DESIGN.md §4.2 — single tier, not severity-scaled). */
export const REPORT_UPHELD_PENALTY = -20;

export interface ReportsHandlers {
  listReports(actor: string, opts?: { status?: string; limit?: number }): Promise<ReportRow[]>;
  resolveReport(
    actor: Actor,
    id: string,
    accountId: string,
    resolution: 'dismissed' | 'upheld',
  ): Promise<{ reputationScore?: number; action?: string }>;
}

export function ReportsMixin<TBase extends AdminBaseCtor>(Base: TBase): TBase & Constructor<ReportsHandlers> {
  return class extends Base {
    /** List reports (reports.view). Defaults to 'open'. Audited (read access to reporter/target ids is itself sensitive). */
    async listReports(actor: string, opts: { status?: string; limit?: number } = {}): Promise<ReportRow[]> {
      if (!this.reports.available) throw new AdminError(503, 'unavailable', 'social backend unavailable');
      const rows = await this.reports.listReports(opts);
      await this.audit(actor, 'report.review', { summary: `${rows.length} reports (status=${opts.status ?? 'open'})` });
      return rows;
    }

    /**
     * Resolve a report (reports.action). 'dismissed' only flips the report's own status. 'upheld' additionally
     * applies REPORT_UPHELD_PENALTY via the metaserver penalty endpoint — the report resolve call and the
     * penalty call are independent (best-effort): if the penalty call fails after the report was already
     * marked upheld, the error surfaces to the caller to retry (the report itself won't re-resolve, see
     * ReportDoc.status guard in socialsvc, so a retry only needs to re-attempt the penalty side in practice).
     */
    async resolveReport(
      actor: Actor,
      id: string,
      accountId: string,
      resolution: 'dismissed' | 'upheld',
    ): Promise<{ reputationScore?: number; action?: string }> {
      if (!this.reports.available) throw new AdminError(503, 'unavailable', 'social backend unavailable');
      const res = await this.reports.resolveReport(id, resolution, actor.adminId);
      if (!res.ok) throw new AdminError(404, 'not_found', 'report not found or already resolved');

      let penalty: { reputationScore?: number; action?: string } = {};
      if (resolution === 'upheld') {
        if (!this.enforcement.available) throw new AdminError(503, 'unavailable', 'enforcement backend unavailable');
        const pen = await this.enforcement.applyPenalty(accountId, REPORT_UPHELD_PENALTY);
        if (!pen.ok) throw new AdminError(502, 'penalty_failed', 'report marked upheld but penalty call failed — retry');
        penalty = { reputationScore: pen.result?.reputationScore, action: pen.result?.action };
      }

      await this.audit(actor.adminId, resolution === 'upheld' ? 'account.penalty' : 'report.review', {
        target: accountId,
        summary: `report ${id} → ${resolution}` + (penalty.action ? ` (${penalty.action}, score=${penalty.reputationScore})` : ''),
      });
      return penalty;
    }
  };
}
