// Player feedback viewer (UI_DESIGN.md §4.1.1 lobby entry, SERVER_API.md §2.13): FeedbackDoc lives in
// metaserver, admin only proxies the read — same "admin proxies, business service owns the data" shape
// as appeals/anti-cheat review. Unlike appeals, there is no resolve/action side: feedback has no status
// machine, ops just reads it.
import type { FeedbackRow } from '../clients';
import type { AdminBaseCtor, Constructor } from './base';
import { AdminError } from './errors';

export interface FeedbackHandlers {
  listFeedback(actor: string, opts?: { limit?: number }): Promise<FeedbackRow[]>;
}

export function FeedbackMixin<TBase extends AdminBaseCtor>(Base: TBase): TBase & Constructor<FeedbackHandlers> {
  return class extends Base {
    /** List player feedback (feedback.view), newest first. Audited (feedback text is player-submitted free text). */
    async listFeedback(actor: string, opts: { limit?: number } = {}): Promise<FeedbackRow[]> {
      if (!this.feedback.available) throw new AdminError(503, 'unavailable', 'feedback backend unavailable');
      const rows = await this.feedback.listFeedback(opts);
      await this.audit(actor, 'feedback.review', { summary: `${rows.length} feedback entries` });
      return rows;
    }
  };
}
