// Pure layer for the player feedback inbox (SERVER_API.md §2.13; ADR-070 Phase 4e).
//
// Deliberately NOT a review queue like reports/appeals: there is no verdict, nothing to dismiss or
// uphold. What it does have is a triage trail so a growing backlog stays trackable — each row is
// unread until someone marks it read or leaves a note (`readAt` stamped once, then never
// overwritten), which is what the Unread/Read filter partitions on.
import type { FeedbackView } from '../types';

/** FEEDBACK_NOTE_MAX (@nw/shared social.ts) — server truncates at the same length. */
export const NOTE_MAX = 500;

export type FeedbackFilter = 'unread' | 'read' | 'all';

/**
 * Split a fetched page into what the table shows plus the unread/total counts. `readAt` is the single
 * read marker (stamped on the first review, never overwritten), so a row carrying only a note cannot
 * exist — no need to consult `note` here.
 *
 * The counts describe the whole fetched page, not the filtered view: "3 unread / 40 total" stays
 * meaningful while looking at the Read tab, which is the point of showing it there at all.
 */
export function partitionFeedback(
  rows: readonly FeedbackView[],
  filter: FeedbackFilter,
): { shown: FeedbackView[]; unread: number; total: number } {
  const unread = rows.filter((f) => !f.readAt).length;
  const shown = filter === 'all' ? [...rows] : rows.filter((f) => (filter === 'unread' ? !f.readAt : !!f.readAt));
  return { shown, unread, total: rows.length };
}

export function countsText(unread: number, total: number): string {
  return `${unread} unread / ${total} total`;
}

/** An empty Unread tab is good news and says so differently from an empty inbox. */
export function emptyText(filter: FeedbackFilter): string {
  return filter === 'unread' ? 'No unread feedback.' : 'No feedback.';
}

/** The read pill plus who stamped it; `by` is absent on rows read before attribution existed. */
export function readStatus(f: Pick<FeedbackView, 'readAt' | 'readBy'>): { read: boolean; bySuffix: string } {
  return { read: !!f.readAt, bySuffix: f.readBy ? ` by ${f.readBy}` : '' };
}

/** Saving with no note is the read-mark path, which leaves an existing note intact server-side. */
export function saveMessage(note: string | undefined): string {
  return note ? 'Saved.' : 'Marked read.';
}

/** One row's plain text cells; timestamps stay numeric for the DOM half. */
export function feedbackCells(f: FeedbackView): { accountId: string; platform: string; text: string } {
  return { accountId: f.accountId, platform: f.clientPlatform ?? '—', text: f.text };
}
