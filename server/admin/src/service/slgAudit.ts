// SLG anomalous trade audit (G7 anti-RMT, §17.7). worldsvc offline scan detects suspicious seller→buyer
// pairs; ops files an audit ticket → single-person adjudication (dismiss for false positive / action for
// confirmed violation). Parallel to compensation tickets: no rewards issued, no two-person approval; review
// is single-person adjudication + audit trail; enforcement (ban/clawback) follows the external liaison process.
import { randomUUID } from 'node:crypto';
import type {
  AuctionAnomaly,
  TradeAuditSnapshot,
  TradeAuditTicketStatus,
  TradeAuditTicketView,
} from '@nw/shared';
import type { TradeAuditTicketDoc } from '../db';
import type { Actor, AdminBaseCtor, Constructor } from './base';
import { AdminError } from './errors';
import { validateAuditSnapshot } from './validators';

export interface SlgAuditHandlers {
  slgScanAnomalies(worldId: string, windowSec?: number): Promise<AuctionAnomaly[]>;
  slgFileAuditTicket(actor: Actor, snapshot: TradeAuditSnapshot): Promise<TradeAuditTicketView>;
  slgListAuditTickets(filter: { status?: string }): Promise<TradeAuditTicketView[]>;
  slgResolveAuditTicket(actor: Actor, id: string, disposition: string, note: string): Promise<TradeAuditTicketView>;
}

export function SlgAuditMixin<TBase extends AdminBaseCtor>(Base: TBase): TBase & Constructor<SlgAuditHandlers> {
  return class extends Base {
    // ───────────────── SLG anomalous trade audit (G7 anti-RMT, §17.7) ─────────────────

    /**
     * Fetch auction anomaly scan (capability slg.audit.view). Returns empty if auctionsvc is unreachable.
     * `worldId` param is kept for route/frontend back-compat but unused: auction task5 (AUCTION_DESIGN §9)
     * moved this scan from the worldsvc worldId-scoped implementation to auctionsvc's global scan.
     */
    async slgScanAnomalies(worldId: string, windowSec?: number): Promise<AuctionAnomaly[]> {
      if (!this.auction.available) return [];
      return this.auction.scanAnomalies(windowSec);
    }

    /**
     * File an anomalous trade audit ticket (capability slg.audit.manage). Freezes the snapshot + deduplicates by pairKey:
     * if an open ticket already exists for the same pair, returns it directly (idempotent, no duplicate filing). Audited as slg.audit.file.
     */
    async slgFileAuditTicket(actor: Actor, snapshot: TradeAuditSnapshot): Promise<TradeAuditTicketView> {
      const snap = validateAuditSnapshot(snapshot);
      const pairKey = `${snap.worldId}:${snap.sellerId}:${snap.buyerId}`;
      const existing = await this.cols.tradeAuditTickets.findOne({ pairKey, status: 'open' });
      if (existing) return this.toAuditTicketView(existing);
      const doc: TradeAuditTicketDoc = {
        _id: randomUUID(),
        pairKey,
        snapshot: snap,
        status: 'open',
        filedBy: actor.adminId,
        filedAt: this.now(),
      };
      await this.cols.tradeAuditTickets.insertOne(doc);
      await this.audit(actor.adminId, 'slg.audit.file', {
        target: doc._id,
        summary: `${snap.worldId} ${snap.sellerId}→${snap.buyerId} ${snap.severity} coins=${snap.totalCoins}`,
      });
      return this.toAuditTicketView(doc);
    }

    /** List audit tickets (capability slg.audit.view), optionally filtered by status, ordered by filing time descending. */
    async slgListAuditTickets(filter: { status?: string }): Promise<TradeAuditTicketView[]> {
      const q: Partial<Record<'status', TradeAuditTicketStatus>> = {};
      if (filter.status) {
        if (filter.status !== 'open' && filter.status !== 'dismissed' && filter.status !== 'actioned') {
          throw new AdminError(400, 'bad_request', 'invalid status');
        }
        q.status = filter.status;
      }
      const docs = await this.cols.tradeAuditTickets.find(q).sort({ filedAt: -1 }).limit(200).toArray();
      return Promise.all(docs.map((d) => this.toAuditTicketView(d)));
    }

    /**
     * Adjudicate an audit ticket (capability slg.audit.manage): open → dismissed (false positive) / actioned (confirmed violation).
     * Only open tickets can be adjudicated (atomic guard prevents concurrent double-adjudication). Audited as slg.audit.resolve.
     */
    async slgResolveAuditTicket(
      actor: Actor,
      id: string,
      disposition: string,
      note: string,
    ): Promise<TradeAuditTicketView> {
      if (disposition !== 'dismissed' && disposition !== 'actioned') {
        throw new AdminError(400, 'bad_request', 'disposition must be dismissed|actioned');
      }
      const doc = await this.cols.tradeAuditTickets.findOne({ _id: id });
      if (!doc) throw new AdminError(404, 'not_found', 'no such ticket');
      if (doc.status !== 'open') throw new AdminError(409, 'conflict', `ticket is ${doc.status}`);
      const trimmedNote = (note ?? '').trim();
      const res = await this.cols.tradeAuditTickets.findOneAndUpdate(
        { _id: id, status: 'open' },
        {
          $set: {
            status: disposition,
            resolvedBy: actor.adminId,
            resolvedAt: this.now(),
            ...(trimmedNote ? { note: trimmedNote } : {}),
          },
        },
        { returnDocument: 'after' },
      );
      if (!res) throw new AdminError(409, 'conflict', 'ticket no longer open');
      await this.audit(actor.adminId, 'slg.audit.resolve', {
        target: id,
        summary: `${disposition}${trimmedNote ? `: ${trimmedNote}` : ''}`,
      });
      return this.toAuditTicketView(res);
    }

    private async toAuditTicketView(doc: TradeAuditTicketDoc): Promise<TradeAuditTicketView> {
      const names = await this.actorNames([doc.filedBy, doc.resolvedBy].filter((x): x is string => !!x));
      return {
        id: doc._id,
        snapshot: doc.snapshot,
        status: doc.status,
        filedBy: doc.filedBy,
        ...(names.get(doc.filedBy) ? { filedByName: names.get(doc.filedBy)! } : {}),
        filedAt: doc.filedAt,
        ...(doc.note ? { note: doc.note } : {}),
        ...(doc.resolvedBy ? { resolvedBy: doc.resolvedBy } : {}),
        ...(doc.resolvedBy && names.get(doc.resolvedBy) ? { resolvedByName: names.get(doc.resolvedBy)! } : {}),
        ...(doc.resolvedAt ? { resolvedAt: doc.resolvedAt } : {}),
      };
    }
  };
}
