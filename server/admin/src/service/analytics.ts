// Audit query + monitoring / trends / analytics + player lookup/search + anti-cheat review queue + sampling
// (OPS_DESIGN §5). Read-mostly surfaces backed by self-collected metric snapshots and the analytics/player clients.
import {
  roleHasCapability,
  validatePassword,
  METRIC_KEYS,
  type AuditEntryView,
  type CompTicketStatus,
  type LiveStats,
  type MetricKey,
  type TrendPoint,
} from '@nw/shared';
import type { AnalyticsQueryResult, AntiCheatReviewRow, PlayerProfile, PlayerSummary } from '../clients';
import type { Actor, AdminBaseCtor, Constructor } from './base';
import { AdminError } from './errors';

const ALL_TICKET_STATUS: readonly CompTicketStatus[] = [
  'pending',
  'approved',
  'executed',
  'rejected',
  'cancelled',
  'failed',
];

export interface AnalyticsHandlers {
  listAudit(actor: Actor, filter: { actor?: string; from?: number; to?: number }): Promise<AuditEntryView[]>;
  liveStats(): Promise<LiveStats & { available: boolean }>;
  trend(input: { metric: string; from?: number; to?: number }): Promise<TrendPoint[]>;
  analyticsSummary(): Promise<{
    live: LiveStats & { available: boolean };
    last24h: Record<MetricKey, { avg: number; peak: number; samples: number }>;
    tickets: Record<CompTicketStatus, number>;
  }>;
  analyticsQuery(type: string, days: number, platform?: string): Promise<AnalyticsQueryResult & { available: boolean }>;
  lookupPlayer(publicId: string): Promise<PlayerProfile>;
  lookupPlayerByAccountId(accountId: string): Promise<PlayerProfile>;
  searchPlayers(actor: string, q: string): Promise<PlayerSummary[]>;
  resetPlayerPassword(actor: string, accountId: string, password: string): Promise<void>;
  listAntiCheatReviews(
    actor: string,
    opts?: { accountId?: string; status?: string; limit?: number },
  ): Promise<AntiCheatReviewRow[]>;
  sampleOnce(): Promise<void>;
}

export function AnalyticsMixin<TBase extends AdminBaseCtor>(Base: TBase): TBase & Constructor<AnalyticsHandlers> {
  return class extends Base {
    // ───────────────────────── Audit ─────────────────────────

    /**
     * Audit query. audit.view.all → all entries (optionally filtered by actor); otherwise only the caller's own entries (audit.view.self).
     * httpApi has already verified "at least audit.view.self"; this method further narrows the visible range based on capability.
     */
    async listAudit(
      actor: Actor,
      filter: { actor?: string; from?: number; to?: number },
    ): Promise<AuditEntryView[]> {
      const canAll = roleHasCapability(actor.role, 'audit.view.all');
      const q: Record<string, unknown> = {};
      if (canAll) {
        if (filter.actor) q.actor = filter.actor;
      } else {
        q.actor = actor.adminId; // force visibility to own entries only
      }
      if (filter.from !== undefined || filter.to !== undefined) {
        const ts: Record<string, number> = {};
        if (filter.from !== undefined) ts.$gte = filter.from;
        if (filter.to !== undefined) ts.$lte = filter.to;
        q.ts = ts;
      }
      const docs = await this.cols.auditLog.find(q).sort({ ts: -1 }).limit(500).toArray();
      const names = await this.actorNames(docs.map((d) => d.actor));
      return docs.map((d) => ({
        id: d._id,
        actor: d.actor,
        ...(names.get(d.actor) ? { actorName: names.get(d.actor)! } : {}),
        action: d.action,
        ...(d.target ? { target: d.target } : {}),
        ...(d.summary ? { summary: d.summary } : {}),
        ...(d.ip ? { ip: d.ip } : {}),
        ts: d.ts,
      }));
    }

    // ───────────────────────── Monitoring / trends / analytics ─────────────────────────

    async liveStats(): Promise<LiveStats & { available: boolean }> {
      const live = await this.stats.fetchLive();
      return { ...live, available: this.stats.available };
    }

    async trend(input: { metric: string; from?: number; to?: number }): Promise<TrendPoint[]> {
      if (!METRIC_KEYS.includes(input.metric as MetricKey)) {
        throw new AdminError(400, 'bad_request', 'invalid metric');
      }
      const q: Record<string, unknown> = { metric: input.metric };
      if (input.from !== undefined || input.to !== undefined) {
        const ts: Record<string, number> = {};
        if (input.from !== undefined) ts.$gte = input.from;
        if (input.to !== undefined) ts.$lte = input.to;
        q.ts = ts;
      }
      const docs = await this.cols.metricSnapshots
        .find(q)
        .sort({ ts: 1 })
        .limit(2000)
        .toArray();
      return docs.map((d) => ({ ts: d.ts, value: d.value }));
    }

    /** Analytics overview (aggregated self-collected metrics + ticket status counts). */
    async analyticsSummary(): Promise<{
      live: LiveStats & { available: boolean };
      last24h: Record<MetricKey, { avg: number; peak: number; samples: number }>;
      tickets: Record<CompTicketStatus, number>;
    }> {
      const live = await this.liveStats();
      const since = this.now() - 24 * 3600 * 1000;
      const last24h = {} as Record<MetricKey, { avg: number; peak: number; samples: number }>;
      for (const metric of METRIC_KEYS) {
        const docs = await this.cols.metricSnapshots
          .find({ metric, ts: { $gte: since } })
          .toArray();
        const samples = docs.length;
        const sum = docs.reduce((s, d) => s + d.value, 0);
        const peak = docs.reduce((m, d) => Math.max(m, d.value), 0);
        last24h[metric] = { avg: samples ? sum / samples : 0, peak, samples };
      }
      const tickets = {} as Record<CompTicketStatus, number>;
      for (const st of ALL_TICKET_STATUS) {
        tickets[st] = await this.cols.compTickets.countDocuments({ status: st });
      }
      return { live, last24h, tickets };
    }

    /** Aggregated analytics query (proxied to analyticsvc /internal/query, A9-6). */
    async analyticsQuery(type: string, days: number, platform?: string): Promise<AnalyticsQueryResult & { available: boolean }> {
      if (!this.analytics.available) return { available: false };
      const result = await this.analytics.query(type, days, platform);
      return { ...result, available: true };
    }

    /** Player lookup (player.lookup). */
    async lookupPlayer(publicId: string): Promise<PlayerProfile> {
      const pid = (publicId ?? '').trim();
      if (!/^\d{9}$/.test(pid)) throw new AdminError(400, 'bad_request', 'publicId must be 9 digits');
      if (!this.players.available) {
        throw new AdminError(503, 'unavailable', 'player lookup backend unavailable');
      }
      const p = await this.players.lookupByPublicId(pid);
      if (!p) throw new AdminError(404, 'not_found', 'no such player');
      return p;
    }

    /** Look up player details by accountId (player.lookup; called after clicking a fuzzy-search result for details). */
    async lookupPlayerByAccountId(accountId: string): Promise<PlayerProfile> {
      const id = (accountId ?? '').trim();
      if (!id) throw new AdminError(400, 'bad_request', 'accountId required');
      if (!this.players.available) {
        throw new AdminError(503, 'unavailable', 'player lookup backend unavailable');
      }
      const p = await this.players.lookupByAccountId(id);
      if (!p) throw new AdminError(404, 'not_found', 'no such player');
      return p;
    }

    /** Fuzzy player search (player.lookup): by display name / login name / public id / accountId; returns a list of matching summaries. Audited. */
    async searchPlayers(actor: string, q: string): Promise<PlayerSummary[]> {
      const term = (q ?? '').trim();
      if (term.length < 2) throw new AdminError(400, 'bad_request', 'query too short (min 2)');
      if (!this.players.available) {
        throw new AdminError(503, 'unavailable', 'player lookup backend unavailable');
      }
      const rows = await this.players.search(term, 20);
      await this.audit(actor, 'player.search', { summary: `q=${term} → ${rows.length} hits` });
      return rows;
    }

    /**
     * Admin-only password reset for a player with no self-service recovery path (player.password_reset,
     * super role only — capability checked by httpApi before this is called). Bypasses the old-password
     * check that /auth/password/change requires.
     */
    async resetPlayerPassword(actor: string, accountId: string, password: string): Promise<void> {
      const id = (accountId ?? '').trim();
      if (!id) throw new AdminError(400, 'bad_request', 'accountId required');
      const pwErr = validatePassword(password);
      if (pwErr) throw new AdminError(400, 'bad_request', pwErr);
      if (!this.players.available) {
        throw new AdminError(503, 'unavailable', 'player lookup backend unavailable');
      }
      const result = await this.players.resetPassword(id, password);
      if (!result.ok) throw new AdminError(409, 'reset_failed', result.error);
      await this.audit(actor, 'player.password_reset', { target: id });
    }

    /** Achievement anti-cheat review queue (anticheat.view, S9-7). Defaults to open status; can be filtered by accountId. Audited. */
    async listAntiCheatReviews(
      actor: string,
      opts: { accountId?: string; status?: string; limit?: number } = {},
    ): Promise<AntiCheatReviewRow[]> {
      if (!this.antiCheat.available) {
        throw new AdminError(503, 'unavailable', 'anti-cheat backend unavailable');
      }
      const rows = await this.antiCheat.listReviews(opts);
      await this.audit(actor, 'anticheat.view', {
        ...(opts.accountId ? { target: opts.accountId } : {}),
        summary: `${rows.length} reviews (status=${opts.status ?? 'open'})`,
      });
      return rows;
    }

    // ───────────────────────── Sampling (OPS_DESIGN §5) ─────────────────────────

    /** Take one live-state time-series snapshot (called by the sampling timer). Records 0 on error (sampling must not be interrupted). */
    async sampleOnce(): Promise<void> {
      const live = await this.stats.fetchLive();
      const ts = this.now();
      const at = new Date(ts);
      const vals: Record<MetricKey, number> = {
        online: live.online,
        queue: live.queue,
        rooms: live.rooms,
        gameInstances: live.gameInstances,
        gameLoad: live.gameLoad ?? 0,
      };
      await this.cols.metricSnapshots.insertMany(
        METRIC_KEYS.map((metric) => ({ metric, ts, value: vals[metric], at })),
      );
    }
  };
}
