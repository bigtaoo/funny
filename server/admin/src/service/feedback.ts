// Player feedback viewer (UI_DESIGN.md §4.1.1 lobby entry, SERVER_API.md §2.13): FeedbackDoc lives in
// metaserver, admin only proxies the read — same "admin proxies, business service owns the data" shape
// as appeals/anti-cheat review. Unlike appeals, there is no resolve/action side: feedback has no status
// machine, ops just reads it.
import type { FeedbackRow } from '../clients';
import type { AdminCore } from './base';
import { AdminError } from './errors';

export interface FeedbackHandlers {
  listFeedback(actor: string, opts?: { limit?: number }): Promise<FeedbackRow[]>;
}

export class FeedbackService {
  constructor(private readonly core: AdminCore) {}

    /** List player feedback (feedback.view), newest first. Audited (feedback text is player-submitted free text). */
    async listFeedback(actor: string, opts: { limit?: number } = {}): Promise<FeedbackRow[]> {
      if (!this.core.feedback.available) throw new AdminError(503, 'unavailable', 'feedback backend unavailable');
      const rows = await this.core.feedback.listFeedback(opts);
      await this.core.audit(actor, 'feedback.review', { summary: `${rows.length} feedback entries` });
      return rows;
    }
}
