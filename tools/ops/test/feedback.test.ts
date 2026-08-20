// src/logic/feedback.ts — the read/unread partition (SERVER_API.md §2.13 triage trail). The backend serves one flat
// newest-first list with no read filter, so the page splits it client-side — this is where "unread"
// is actually defined for the operator, hence the coverage. pageFeedback() builds DOM and stays untested,
// same split as appeals.test.ts.
import { describe, it, expect } from 'vitest';
import {
  countsText, emptyText, feedbackCells, NOTE_MAX, partitionFeedback, readStatus, saveMessage,
} from '../src/logic/feedback';
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

describe('countsText', () => {
  it('describes the whole fetched page, which is why it is shown on every tab', () => {
    expect(countsText(3, 40)).toBe('3 unread / 40 total');
    expect(countsText(0, 0)).toBe('0 unread / 0 total');
  });
});

describe('emptyText', () => {
  it('says something different for an empty Unread tab — that is good news, not an empty inbox', () => {
    expect(emptyText('unread')).toBe('No unread feedback.');
    expect(emptyText('read')).toBe('No feedback.');
    expect(emptyText('all')).toBe('No feedback.');
  });
});

describe('readStatus', () => {
  it('reports an unread row with no attribution', () => {
    expect(readStatus({})).toEqual({ read: false, bySuffix: '' });
  });

  it('names who stamped it when the row carries that', () => {
    expect(readStatus({ readAt: 5, readBy: 'Ada' })).toEqual({ read: true, bySuffix: ' by Ada' });
  });

  it('omits the attribution for a row read before attribution existed', () => {
    expect(readStatus({ readAt: 5 })).toEqual({ read: true, bySuffix: '' });
  });
});

describe('saveMessage', () => {
  it('distinguishes saving a note from the read-mark-only path', () => {
    expect(saveMessage('forwarded to design')).toBe('Saved.');
    expect(saveMessage(undefined)).toBe('Marked read.');
    // An empty string CLEARS an existing note server-side, and reads as the read-mark message here.
    expect(saveMessage('')).toBe('Marked read.');
  });
});

describe('feedbackCells', () => {
  it('dashes an absent platform rather than printing "undefined"', () => {
    expect(feedbackCells(row('a'))).toEqual({ accountId: 'acc-a', platform: '—', text: 'text a' });
  });

  it('passes a known platform through', () => {
    expect(feedbackCells(row('a', { clientPlatform: 'wechat' })).platform).toBe('wechat');
  });
});

describe('NOTE_MAX', () => {
  it('matches the server-side FEEDBACK_NOTE_MAX the textarea advertises', () => {
    expect(NOTE_MAX).toBe(500);
  });
});
