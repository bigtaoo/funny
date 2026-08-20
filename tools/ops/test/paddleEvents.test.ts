// src/logic/paddleEvents.ts — the Paddle webhook log's search filter and raw-body viewer.
import { describe, expect, it } from 'vitest';
import { detailTitle, paddleCells, paddleQuery, prettyRawEvent } from '../src/logic/paddleEvents';
import type { PaddleEventView } from '../src/types';

describe('paddleQuery', () => {
  it('sends nothing when both fields are blank — that means "most recent events"', () => {
    expect(paddleQuery('', '')).toEqual({});
    expect(paddleQuery('   ', '  ')).toEqual({});
  });

  it('trims each field it does send', () => {
    expect(paddleQuery(' acc-1 ', ' txn_1 ')).toEqual({ accountId: 'acc-1', transactionId: 'txn_1' });
  });

  it('sends either field alone', () => {
    expect(paddleQuery('acc-1', '')).toEqual({ accountId: 'acc-1' });
    expect(paddleQuery('', 'txn_1')).toEqual({ transactionId: 'txn_1' });
  });
});

describe('prettyRawEvent', () => {
  it('re-indents a JSON body', () => {
    expect(prettyRawEvent('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it('shows an unparseable body verbatim — being unreadable is itself the finding', () => {
    expect(prettyRawEvent('{truncated...')).toBe('{truncated...');
    expect(prettyRawEvent('')).toBe('');
  });
});

describe('row rendering', () => {
  const e: PaddleEventView = { transactionId: 'txn_1', eventType: 'transaction.payment_failed', rawEvent: '{}', ts: 1 };

  it('titles the detail pane with the event and its transaction', () => {
    expect(detailTitle(e)).toBe('transaction.payment_failed — txn_1');
  });

  it('reads an absent status or account as an em dash', () => {
    expect(paddleCells(e)).toEqual({
      eventType: 'transaction.payment_failed', status: '—', transactionId: 'txn_1', accountId: '—',
    });
  });

  it('passes through a status and account when present', () => {
    expect(paddleCells({ ...e, status: 'past_due', accountId: 'acc-1' })).toMatchObject({ status: 'past_due', accountId: 'acc-1' });
  });
});
