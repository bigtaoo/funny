// feedback.ts's read/unread partition (SERVER_API.md §2.13 triage trail). The backend serves one flat
// newest-first list with no read filter, so the page splits it client-side — this is where "unread"
// is actually defined for the operator, hence the coverage. pageFeedback() builds DOM and stays untested,
// same split as appeals.test.ts.
import { describe, it, expect } from 'vitest';
import { partitionFeedback } from '../src/pages/feedback';
import type { FeedbackView } from '../src/types';

const row = (id: string, extra: Partial<FeedbackView> = {}): FeedbackView => ({
  _id: id, accountId: `acc-${id}`, text: `text ${id}`, createdAt: 1, ...extra,
});

describe('partitionFeedback', () => {
  const unread1 = row('a');
  const unread2 = row('b');
  const read = row('c', { readAt: 100, readBy: 'admin-1' });
  const noted = row('d', { readAt: 200, readBy: 'admin-2', note: 'forwarded to design' });
  const rows = [unread1, read, unread2, noted];

  it('counts unread against the whole fetched page, not the filtered view', () => {
    for (const filter of ['unread', 'read', 'all'] as const) {
      expect(partitionFeedback(rows, filter)).toMatchObject({ unread: 2, total: 4 });
    }
  });

  it('"unread" shows only rows with no readAt, in the order served', () => {
    expect(partitionFeedback(rows, 'unread').shown).toEqual([unread1, unread2]);
  });

  it('"read" shows every reviewed row, whether or not it carries a note', () => {
    expect(partitionFeedback(rows, 'read').shown).toEqual([read, noted]);
  });

  it('"all" passes the page through untouched', () => {
    expect(partitionFeedback(rows, 'all').shown).toEqual(rows);
  });

  it('does not mutate or alias the caller\'s array (the page reloads into the same variable)', () => {
    const all = partitionFeedback(rows, 'all').shown;
    all.push(row('e'));
    expect(rows).toHaveLength(4);
  });

  it('a note without readAt cannot occur, but if it did the row still counts as unread (readAt is the only marker)', () => {
    const orphanNote = row('x', { note: 'note but never marked read' });
    expect(partitionFeedback([orphanNote], 'unread')).toMatchObject({ shown: [orphanNote], unread: 1 });
  });

  it('handles an empty page', () => {
    expect(partitionFeedback([], 'unread')).toEqual({ shown: [], unread: 0, total: 0 });
  });
});
