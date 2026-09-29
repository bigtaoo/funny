// UGC report review queue (CONTENT_MODERATION_DESIGN.md CM9/CM11): admin is the "processing hub" — it
// resolves the report itself (socialsvc) and, on 'upheld', separately calls the metaserver penalty
// endpoint (CM7's single enforcement path) in the same operation. Two calls, best-effort (no distributed
// transaction, same pragmatic choice as TradeAuditTicketView's auto-ban — see slgAudit.ts).
import type { ReportRow, SocialPurgeResult, WorldPurgeResult } from '../clients';
import type { Actor, AdminCore } from './base';
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
  deleteReportedContent(actor: Actor, id: string): Promise<{ deleted: boolean; channel: string }>;
  purgeAuthorContent(actor: Actor, accountId: string): Promise<PurgeAuthorContentResult>;
}

/** Per-backend outcome of a purge: counts on success, an error string when that backend failed or is absent. */
export interface PurgeAuthorContentResult {
  social: SocialPurgeResult | { error: string };
  world: WorldPurgeResult | { error: string };
}

export class ReportsService {
  constructor(private readonly core: AdminCore) {}

    /** List reports (reports.view). Defaults to 'open'. Audited (read access to reporter/target ids is itself sensitive). */
    async listReports(actor: string, opts: { status?: string; limit?: number } = {}): Promise<ReportRow[]> {
      if (!this.core.reports.available) throw new AdminError(503, 'unavailable', 'social backend unavailable');
      const rows = await this.core.reports.listReports(opts);
      await this.core.audit(actor, 'report.review', { summary: `${rows.length} reports (status=${opts.status ?? 'open'})` });
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
      if (!this.core.reports.available) throw new AdminError(503, 'unavailable', 'social backend unavailable');

      let row = (await this.core.reports.listReports({ status: 'open', limit: 1000 })).find((r) => r._id === id);
      let alreadyResolved = false;
      if (!row) {
        row = (await this.core.reports.listReports({ status: resolution, limit: 1000 })).find((r) => r._id === id);
        if (row) alreadyResolved = true;
      }
      if (!row) throw new AdminError(404, 'not_found', 'report not found or already resolved');
      if (row.targetId !== accountId) {
        throw new AdminError(400, 'target_mismatch', `accountId ${accountId} does not match report's own target`);
      }

      if (!alreadyResolved) {
        const res = await this.core.reports.resolveReport(id, resolution, actor.adminId);
        if (!res.ok) throw new AdminError(404, 'not_found', 'report not found or already resolved');
      }

      let penalty: { reputationScore?: number; action?: string } = {};
      if (resolution === 'upheld') {
        if (!this.core.enforcement.available) throw new AdminError(503, 'unavailable', 'enforcement backend unavailable');
        const pen = await this.core.enforcement.applyPenalty(row.targetId, REPORT_UPHELD_PENALTY);
        if (!pen.ok) throw new AdminError(502, 'penalty_failed', 'report marked upheld but penalty call failed — retry');
        penalty = { reputationScore: pen.result?.reputationScore, action: pen.result?.action };
      }

      await this.core.audit(actor.adminId, resolution === 'upheld' ? 'account.penalty' : 'report.review', {
        target: row.targetId,
        summary: `report ${id} → ${resolution}` + (penalty.action ? ` (${penalty.action}, score=${penalty.reputationScore})` : ''),
      });
      return penalty;
    }

    /** Find a report in any status (content removal is also useful after a report was upheld). */
    private async findReport(id: string): Promise<ReportRow | undefined> {
      for (const status of ['open', 'upheld', 'dismissed'] as const) {
        const row = (await this.core.reports.listReports({ status, limit: 1000 })).find((r) => r._id === id);
        if (row) return row;
      }
      return undefined;
    }

    /**
     * Remove the one piece of content a report points at (reports.action; App Store Review Guideline 1.2 —
     * "remove the content within 24 hours"). Routed by the report's own `contentRef.channel`: DM/family/
     * announcement to socialsvc, sect/world to worldsvc. `name` and `mail` have no single removable message —
     * rename/ban the player or purge the author instead; those are rejected with a 400 that says so.
     */
    async deleteReportedContent(actor: Actor, id: string): Promise<{ deleted: boolean; channel: string }> {
      if (!this.core.reports.available) throw new AdminError(503, 'unavailable', 'social backend unavailable');
      const row = await this.findReport(id);
      if (!row) throw new AdminError(404, 'not_found', 'report not found');
      const ref = row.contentRef;
      if (!ref || ref.kind !== 'content') throw new AdminError(400, 'no_content', 'report does not point at a message');
      const { channel } = ref;
      let deleted: boolean;
      try {
        if (channel === 'announcement') {
          deleted = (await this.core.moderation.deleteSocialContent('announcement', { targetId: row.targetId })).deleted;
        } else if (channel === 'dm' || channel === 'family' || channel === 'sect' || channel === 'world') {
          if (!ref.messageId) throw new AdminError(400, 'no_message_id', 'report has no messageId — purge the author instead');
          deleted =
            channel === 'dm' || channel === 'family'
              ? (await this.core.moderation.deleteSocialContent(channel, { messageId: ref.messageId })).deleted
              : (await this.core.moderation.deleteWorldMessage(channel, ref.messageId)).deleted;
        } else {
          throw new AdminError(400, 'unsupported_channel', `${channel} content has no single message to delete — purge the author or ban/rename instead`);
        }
      } catch (e) {
        if (e instanceof AdminError) throw e;
        throw new AdminError(502, 'moderation_failed', (e as Error).message);
      }
      await this.core.audit(actor.adminId, 'report.content.remove', {
        target: row.targetId,
        summary: `report ${id}: ${channel} message ${ref.messageId ?? '(announcement)'} → ${deleted ? 'deleted' : 'already gone'}`,
      });
      return { deleted, channel };
    }

    /**
     * Remove every chat message / announcement / mail an account authored, across socialsvc and worldsvc
     * (reports.action; Guideline 1.2 — pairs with the existing ban for "eject the user"). The two backends
     * are independent: one failing doesn't stop the other, and each side's outcome is reported separately
     * so the operator can retry exactly the half that failed (both purges are idempotent).
     */
    async purgeAuthorContent(actor: Actor, accountId: string): Promise<PurgeAuthorContentResult> {
      if (!accountId) throw new AdminError(400, 'bad_request', 'accountId required');
      const settle = async <T>(fn: () => Promise<T>): Promise<T | { error: string }> => {
        try {
          return await fn();
        } catch (e) {
          return { error: (e as Error).message };
        }
      };
      const [social, world] = await Promise.all([
        settle(() => this.core.moderation.purgeSocialAuthor(accountId)),
        settle(() => this.core.moderation.purgeWorldAuthor(accountId)),
      ]);
      await this.core.audit(actor.adminId, 'report.content.remove', {
        target: accountId,
        summary: `purge author: social=${JSON.stringify(social)} world=${JSON.stringify(world)}`,
      });
      return { social, world };
    }
}
