// Player appeal review queue (CONTENT_MODERATION_DESIGN.md CM10/CM11): AppealDoc lives in metaserver
// (account-level enforcement state is metaserver's authority), admin only proxies list/resolve calls —
// same "admin proxies, business service owns the data" shape as the anti-cheat review queue.
import type { AppealRow } from '../clients';
import type { Actor, AdminBaseCtor, Constructor } from './base';
import { AdminError } from './errors';

export interface AppealsHandlers {
  listAppeals(actor: string, opts?: { status?: string; limit?: number }): Promise<AppealRow[]>;
  resolveAppeal(actor: Actor, id: string, resolution: 'approved' | 'denied', note?: string): Promise<void>;
}

export function AppealsMixin<TBase extends AdminBaseCtor>(Base: TBase): TBase & Constructor<AppealsHandlers> {
  return class extends Base {
    /** List appeals (appeals.view). Defaults to 'open'. Audited (appeal reason text is player-submitted free text). */
    async listAppeals(actor: string, opts: { status?: string; limit?: number } = {}): Promise<AppealRow[]> {
      if (!this.appeals.available) throw new AdminError(503, 'unavailable', 'appeal backend unavailable');
      const rows = await this.appeals.listAppeals(opts);
      await this.audit(actor, 'appeal.review', { summary: `${rows.length} appeals (status=${opts.status ?? 'open'})` });
      return rows;
    }

    /**
     * Resolve an appeal (appeals.action). Approving clears the account's active mute/temp-ban/ban fields
     * (metaserver-side, CM10) — deliberately does NOT restore reputationScore (a separate, explicit admin
     * adjustment if warranted, so a still-low score from other unresolved reports isn't silently wiped).
     */
    async resolveAppeal(actor: Actor, id: string, resolution: 'approved' | 'denied', note?: string): Promise<void> {
      if (!this.appeals.available) throw new AdminError(503, 'unavailable', 'appeal backend unavailable');
      const res = await this.appeals.resolveAppeal(id, resolution, actor.adminId, note);
      if (!res.ok) throw new AdminError(404, 'not_found', 'appeal not found or already resolved');
      await this.audit(actor.adminId, 'appeal.review', { target: id, summary: `appeal ${id} → ${resolution}` });
    }
  };
}
