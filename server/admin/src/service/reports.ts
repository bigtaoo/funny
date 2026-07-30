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
     * applies REPORT_UPHELD_PENALTY via the metaserver penalty endpoint.
     *
     * The target account is always derived from the report's own `targetId` (O-CM7, SERVER_LOGIC_AUDIT
     * 2026-07-29) — the caller-supplied `accountId` is only accepted as a confirmation and rejected on
     * mismatch, so a caller bug can't resolve report A while penalizing an unrelated account.
     *
     * The report-resolve call and the penalty call are independent (best-effort, no distributed
     * transaction). If the penalty call fails after the report was already marked upheld, resolveReport()
     * detects on the next call that the report is already resolved to the same `resolution` (O-CM6) and
     * retries *only* the penalty side instead of re-attempting the report-resolve CAS, which would 404
     * forever once the report has left 'open' (see ReportDoc.status guard in socialsvc).
     */
    async resolveReport(
      actor: Actor,
      id: string,
      accountId: string,
      resolution: 'dismissed' | 'upheld',
    ): Promise<{ reputationScore?: number; action?: string }> {
      if (!this.reports.available) throw new AdminError(503, 'unavailable', 'social backend unavailable');

      let row = (await this.reports.listReports({ status: 'open', limit: 1000 })).find((r) => r._id === id);
      let alreadyResolved = false;
      if (!row) {
        row = (await this.reports.listReports({ status: resolution, limit: 1000 })).find((r) => r._id === id);
        if (row) alreadyResolved = true;
      }
      if (!row) throw new AdminError(404, 'not_found', 'report not found or already resolved');
      if (row.targetId !== accountId) {
        throw new AdminError(400, 'target_mismatch', `accountId ${accountId} does not match report's own target`);
      }

      if (!alreadyResolved) {
        const res = await this.reports.resolveReport(id, resolution, actor.adminId);
        if (!res.ok) throw new AdminError(404, 'not_found', 'report not found or already resolved');
      }

      let penalty: { reputationScore?: number; action?: string } = {};
      if (resolution === 'upheld') {
        if (!this.enforcement.available) throw new AdminError(503, 'unavailable', 'enforcement backend unavailable');
        const pen = await this.enforcement.applyPenalty(row.targetId, REPORT_UPHELD_PENALTY);
        if (!pen.ok) throw new AdminError(502, 'penalty_failed', 'report marked upheld but penalty call failed — retry');
        penalty = { reputationScore: pen.result?.reputationScore, action: pen.result?.action };
      }

      await this.audit(actor.adminId, resolution === 'upheld' ? 'account.penalty' : 'report.review', {
        target: row.targetId,
        summary: `report ${id} → ${resolution}` + (penalty.action ? ` (${penalty.action}, score=${penalty.reputationScore})` : ''),
      });
      return penalty;
    }
  };
}
