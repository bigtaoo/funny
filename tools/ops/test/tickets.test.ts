// tickets.ts's target/attachment describers (compensation ticket table's Target/Attachments
// columns). ticketRow()/ticketForm()/pageTickets() build DOM and stay untested.
import { describe, it, expect } from 'vitest';
import { describeTarget, describeAttachments } from '../src/pages/tickets';
import type { CompAttachment, CompTarget } from '../src/types';

describe('describeTarget', () => {
  it('formats a single-player target as #publicId', () => {
    const target: CompTarget = { publicId: '12345678' };
    expect(describeTarget(target)).toBe('#12345678');
  });

  it('formats an all-server target with its filter kind', () => {
    const target: CompTarget = { filter: { kind: 'all' } };
    expect(describeTarget(target)).toBe('all-server(all)');
  });
});

describe('describeAttachments', () => {
  it('returns "none" for an empty list', () => {
    expect(describeAttachments([])).toBe('none');
  });

  it('formats a coins attachment as "<count> coins"', () => {
    const att: CompAttachment[] = [{ kind: 'coins', count: 500 }];
    expect(describeAttachments(att)).toBe('500 coins');
  });

  it('defaults a coins attachment with no count to 0', () => {
    const att: CompAttachment[] = [{ kind: 'coins' }];
    expect(describeAttachments(att)).toBe('0 coins');
  });

  it('formats a non-coins attachment as "kind:id×count"', () => {
    const att: CompAttachment[] = [{ kind: 'item', id: 'wood', count: 10 }];
    expect(describeAttachments(att)).toBe('item:wood×10');
  });

  it('defaults a non-coins attachment\'s missing id to "?" and missing count to 1', () => {
    const att: CompAttachment[] = [{ kind: 'skin' }];
    expect(describeAttachments(att)).toBe('skin:?×1');
  });

  it('joins multiple attachments with ", "', () => {
    const att: CompAttachment[] = [
      { kind: 'coins', count: 500 },
      { kind: 'item', id: 'wood', count: 10 },
    ];
    expect(describeAttachments(att)).toBe('500 coins, item:wood×10');
  });
});
