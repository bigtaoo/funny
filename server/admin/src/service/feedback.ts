// Player feedback viewer (UI_DESIGN.md §4.1.1 lobby entry, SERVER_API.md §2.13): FeedbackDoc lives in
// metaserver, admin only proxies list/review calls — same "admin proxies, business service owns the data"
// shape as appeals/anti-cheat review. Still no resolve/verdict side like appeals (no dismiss/uphold
// outcome) — reviewFeedback (feedback.action) is a lightweight triage trail (read-mark + note), not a
// status machine.
import type { FeedbackRow } from '../clients';
import type { AdminCore } from './base';
import { AdminError } from './errors';

export interface FeedbackHandlers {
  listFeedback(actor: string, opts?: { limit?: number }): Promise<FeedbackRow[]>;
  reviewFeedback(actor: string, id: string, note?: string): Promise<void>;
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

    /**
     * Mark a feedback row read and/or attach a triage note (feedback.action). `note` omitted/empty just
     * marks it read without touching an existing note's text; pass `note: ''` explicitly to clear a note.
     */
    async reviewFeedback(actor: string, id: string, note?: string): Promise<void> {
      if (!this.core.feedback.available) throw new AdminError(503, 'unavailable', 'feedback backend unavailable');
      const res = await this.core.feedback.reviewFeedback(id, actor, note);
      if (!res.ok) throw new AdminError(404, 'not_found', 'feedback not found');
      await this.core.audit(actor, 'feedback.review', { target: id, summary: note ? `feedback ${id} noted` : `feedback ${id} marked read` });
    }
}
