// src/logic/tickets.ts — the compensation ticket page's decisions.
//
// `ticketActions` is the one worth the most: it is this console's most involved permission rule
// (four-eyes approval, the single-super-admin transitional exemption, who may cancel), it mirrors
// rules the backend also enforces, and until Phase 4e it lived inside a DOM row builder where nothing
// could reach it. UX only — the backend re-decides every case, and gets the last word on self-approval.
import { describe, it, expect } from 'vitest';
import {
  approveCapFor, buildTarget, canInitiate, DEFAULT_EXPIRE_DAYS, describeAttachments, describeTarget,
  previewText, statusFilter, ticketActions, ticketInput, ticketPeople, TICKET_STATUSES,
} from '../src/logic/tickets';
import type { AdminCapability, CompAttachment, CompTarget, CompTicketView, Session } from '../src/types';

const session = (caps: AdminCapability[], id = 'adm-me', role = 'ops'): Session => ({
  token: 't',
  admin: { id, username: 'me', role: role as Session['admin']['role'], displayName: 'Me', disabled: false, createdAt: 0 },
  capabilities: caps,
});

const ticket = (over: Partial<CompTicketView> = {}): CompTicketView => ({
  id: 'tk-1', status: 'pending', scope: 'single', target: { publicId: '123456789' },
  mail: { subject: 's', body: 'b', attachments: [], expireDays: 30 }, reason: 'r',
  amountTier: 'normal', initiatedBy: 'adm-other', initiatedAt: 1, ...over,
});

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

describe('TICKET_STATUSES', () => {
  it('leads with the "All" option, which is sent as no filter at all', () => {
    expect(TICKET_STATUSES[0]).toBe('');
    expect(statusFilter('')).toBeUndefined();
    expect(statusFilter('pending')).toBe('pending');
  });

  it('covers the full ticket lifecycle', () => {
    expect(TICKET_STATUSES).toContain('pending');
    expect(TICKET_STATUSES).toContain('executed');
    expect(TICKET_STATUSES).toContain('failed');
  });
});

describe('approveCapFor', () => {
  it('needs the global capability for a server-wide payout', () => {
    expect(approveCapFor({ scope: 'global', amountTier: 'normal' })).toBe('comp.approve.global');
    expect(approveCapFor({ scope: 'global', amountTier: 'overquota' })).toBe('comp.approve.global');
  });

  it('needs the over-quota variant for a large individual payout', () => {
    expect(approveCapFor({ scope: 'single', amountTier: 'overquota' })).toBe('comp.approve.single.overquota');
  });

  it('needs only the plain capability otherwise', () => {
    expect(approveCapFor({ scope: 'single', amountTier: 'normal' })).toBe('comp.approve.single');
  });
});

describe('ticketActions', () => {
  it('offers nothing to an operator without the matching approval capability', () => {
    expect(ticketActions(ticket(), session(['comp.view']))).toEqual([]);
  });

  it('offers ordinary four-eyes approve + reject to a qualified approver who did not initiate it', () => {
    expect(ticketActions(ticket(), session(['comp.approve.single']))).toEqual(['approve', 'reject']);
  });

  it('offers self-approval WITHOUT reject to the initiator — cancel is their route to that outcome', () => {
    const tk = ticket({ initiatedBy: 'adm-me' });
    expect(ticketActions(tk, session(['comp.approve.single']))).toEqual(['approve-self', 'cancel']);
  });

  it('lets the initiator cancel even with no approval capability', () => {
    const tk = ticket({ initiatedBy: 'adm-me' });
    expect(ticketActions(tk, session(['comp.initiate.single']))).toEqual(['cancel']);
  });

  it('lets a super-admin cancel a ticket they did not initiate', () => {
    expect(ticketActions(ticket(), session([], 'adm-me', 'super'))).toEqual(['cancel']);
  });

  it('checks the capability the ticket actually needs, not just any approval capability', () => {
    const overquota = ticket({ amountTier: 'overquota' });
    expect(ticketActions(overquota, session(['comp.approve.single']))).toEqual([]);
    expect(ticketActions(overquota, session(['comp.approve.single.overquota']))).toEqual(['approve', 'reject']);
    const global = ticket({ scope: 'global', target: { filter: { kind: 'all' } } });
    expect(ticketActions(global, session(['comp.approve.single.overquota']))).toEqual([]);
    expect(ticketActions(global, session(['comp.approve.global']))).toEqual(['approve', 'reject']);
  });

  it('offers retry only on a failed execution, and only to someone who could have approved it', () => {
    const failed = ticket({ status: 'failed' });
    expect(ticketActions(failed, session(['comp.approve.single']))).toEqual(['retry']);
    expect(ticketActions(failed, session(['comp.view']))).toEqual([]);
  });

  it('offers nothing on a ticket that has already run its course', () => {
    for (const status of ['approved', 'executed', 'rejected', 'cancelled'] as const) {
      expect(ticketActions(ticket({ status }), session(['comp.approve.single'], 'adm-me', 'super'))).toEqual([]);
    }
  });
});

describe('canInitiate', () => {
  it('is true for either initiate capability', () => {
    expect(canInitiate(session(['comp.initiate.single']))).toBe(true);
    expect(canInitiate(session(['comp.initiate.global']))).toBe(true);
  });

  it('is false for a read-only or approve-only operator', () => {
    expect(canInitiate(session(['comp.view', 'comp.approve.single']))).toBe(false);
  });
});

describe('ticketPeople', () => {
  it('shortens bare ids and dashes an approver nobody has been yet', () => {
    expect(ticketPeople(ticket({ initiatedBy: 'adm-0123456789' }))).toEqual({ initiated: 'adm-0123', approved: '—' });
  });

  it('prefers the display names when the backend sent them', () => {
    expect(ticketPeople(ticket({ initiatedByName: 'Ada', approvedByName: 'Grace' })))
      .toEqual({ initiated: 'Ada', approved: 'Grace' });
  });
});

describe('buildTarget', () => {
  it('trims the public id for a single-recipient ticket', () => {
    expect(buildTarget('single', ' 123456789 ')).toEqual({ publicId: '123456789' });
  });

  it('ignores the public id entirely for a global one', () => {
    expect(buildTarget('global', '123456789')).toEqual({ filter: { kind: 'all' } });
  });
});

describe('ticketInput', () => {
  const fields = {
    scope: 'single', publicId: ' 123456789 ', subject: '  Sorry  ', body: '  have coins  ',
    coins: '500', expireDays: '14', reason: '  outage 2026-08-20  ',
  };

  it('trims the mail fields and the audit reason', () => {
    expect(ticketInput(fields)).toEqual({
      scope: 'single',
      target: { publicId: '123456789' },
      mail: { subject: 'Sorry', body: 'have coins', attachments: [{ kind: 'coins', count: 500 }], expireDays: 14 },
      reason: 'outage 2026-08-20',
    });
  });

  it('attaches nothing for zero or unparseable coins, rather than a "0 coins" attachment', () => {
    expect(ticketInput({ ...fields, coins: '0' }).mail.attachments).toEqual([]);
    expect(ticketInput({ ...fields, coins: '' }).mail.attachments).toEqual([]);
    expect(ticketInput({ ...fields, coins: 'abc' }).mail.attachments).toEqual([]);
  });

  it('falls back to the default expiry when the field is blank or unparseable', () => {
    expect(DEFAULT_EXPIRE_DAYS).toBe(30);
    expect(ticketInput({ ...fields, expireDays: '' }).mail.expireDays).toBe(30);
    expect(ticketInput({ ...fields, expireDays: 'soon' }).mail.expireDays).toBe(30);
  });

  it('builds a global target when the scope says so', () => {
    expect(ticketInput({ ...fields, scope: 'global' }).target).toEqual({ filter: { kind: 'all' } });
  });
});

describe('previewText', () => {
  it('pluralizes the estimate', () => {
    expect(previewText({ recipientCount: 1, available: true })).toBe('Estimated 1 recipient');
    expect(previewText({ recipientCount: 0, available: true })).toBe('Estimated 0 recipients');
  });

  it('says when the estimate could not be produced — "0" and "cannot tell" differ', () => {
    expect(previewText({ recipientCount: 0, available: false }))
      .toBe('Estimated 0 recipients (mail backend not ready, estimate unavailable)');
  });
});
