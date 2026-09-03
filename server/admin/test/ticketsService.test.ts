// TicketsService state-machine and executor branches (compensation flow, OPS_DESIGN §3).
//
// Why this file exists (2026-09-03 branch-coverage pass): tickets.ts printed 94% lines / 65%
// branches — 25 branches never executed. comp-mail.e2e.test.ts drives the happy path end to end
// against a real Mongo, which is exactly why the gap is shaped the way it is: what had never run
// was every REFUSAL and every LOST RACE. Specifically the four `if (!res)` arms — the ones that
// turn a lost status CAS into a 409 instead of letting two operators execute the same
// compensation twice — plus the three `status !== 'pending'` guards, the self-reject/non-initiator
// cancel refusals, and, in the executor, what gets written when the mail backend answers without a
// recipientCount or without an error string.
//
// An e2e test cannot provoke a lost CAS deterministically (both callers have to reach
// findOneAndUpdate in the same instant), so these are stubbed: the collection returns the exact
// findOneAndUpdate result each branch needs. The real driver, indexes and dispatchKey uniqueness
// stay covered by comp-mail.e2e.test.ts.
import { describe, expect, it } from 'vitest';
import type { CompTicketDoc } from '../src/db';
import type { Actor } from '../src/service/base';
import type { TicketsService } from '../src/service/tickets';
import { domain, stubDeps, NOW } from './stubDeps';

const SUPER: Actor = { adminId: 'adm-1', username: 'root', displayName: 'Root', role: 'super' };
const OTHER_SUPER: Actor = { adminId: 'adm-2', username: 'root2', displayName: 'Root Two', role: 'super' };
const OPS: Actor = { adminId: 'adm-3', username: 'ops', displayName: 'Ops', role: 'ops' };
const SUPPORT: Actor = { adminId: 'adm-4', username: 'cs', displayName: 'CS', role: 'support' };

const MAIL = { subject: 'sorry', body: 'have some coins', attachments: [{ kind: 'coins' as const, count: 100 }], expireDays: 30 };

const TICKET: CompTicketDoc = {
  _id: 't1',
  scope: 'single',
  target: { publicId: '123456789' },
  mail: MAIL,
  reason: 'lost items in a crash',
  status: 'pending',
  amountTier: 'normal',
  initiatedBy: 'adm-1',
  initiatedAt: 1,
  dispatchKey: 'dk-1',
};

interface Options {
  /** `findOne` result — null means "no such ticket". */
  ticket?: CompTicketDoc | null;
  /** Queued `findOneAndUpdate` results; once exhausted the stub applies `$set` and returns the doc. */
  cas?: Array<CompTicketDoc | null>;
  /** `hasOtherEligibleApprover`'s count query result. */
  approvers?: number;
  mailSend?: { ok: boolean; recipientCount?: number; error?: string };
  mailPreview?: { ok: boolean; recipientCount: number };
  /** Admin accounts `actorNames` resolves against. */
  accountRows?: Array<{ _id: string; displayName?: string; username?: string }>;
  list?: CompTicketDoc[];
}

function harness(o: Options = {}) {
  let current = o.ticket === undefined ? TICKET : o.ticket;
  const casQueue = [...(o.cas ?? [])];
  const cas: Array<{ filter: Record<string, unknown>; set: Record<string, unknown> }> = [];
  const inserted: CompTicketDoc[] = [];
  const listQueries: unknown[] = [];
  const sent: unknown[] = [];
  const previewed: unknown[] = [];

  const { deps, audits } = stubDeps({
    mail: {
      send: async (args: unknown) => {
        sent.push(args);
        return o.mailSend ?? { ok: true, recipientCount: 1 };
      },
      preview: async (args: unknown) => {
        previewed.push(args);
        return o.mailPreview ?? { ok: true, recipientCount: 42 };
      },
    },
    cols: {
      compTickets: {
        findOne: async () => current,
        insertOne: async (doc: CompTicketDoc) => {
          inserted.push(doc);
          return { acknowledged: true };
        },
        findOneAndUpdate: async (
          filter: Record<string, unknown>,
          update: { $set?: Record<string, unknown> },
        ) => {
          cas.push({ filter, set: update.$set ?? {} });
          if (casQueue.length) return casQueue.shift() ?? null;
          current = { ...(current as CompTicketDoc), ...(update.$set as Partial<CompTicketDoc>) };
          return current;
        },
        find: (q: unknown) => {
          listQueries.push(q);
          const rows = o.list ?? [];
          const self = { sort: () => self, limit: () => self, toArray: async () => rows };
          return self;
        },
      },
      adminAccounts: {
        countDocuments: async () => o.approvers ?? 0,
        find: () => {
          const rows = o.accountRows ?? [];
          const self = { sort: () => self, limit: () => self, toArray: async () => rows };
          return self;
        },
      },
    },
  });
  return {
    svc: domain<TicketsService>(deps, 'tickets'),
    audits,
    cas,
    inserted,
    listQueries,
    sent,
    previewed,
  };
}

describe('initiateTicket', () => {
  const input = { scope: 'single', target: { publicId: '123456789' }, mail: MAIL, reason: 'crash refund' };

  it('rejects a scope that is neither single nor global', async () => {
    const h = harness();
    for (const scope of ['team', '', undefined as unknown as string]) {
      await expect(h.svc.initiateTicket(SUPER, { ...input, scope })).rejects.toMatchObject({
        status: 400,
        message: 'scope must be single|global',
      });
    }
    expect(h.inserted).toEqual([]);
  });

  it('requires a reason — missing, empty and whitespace-only all rejected', async () => {
    const h = harness();
    for (const reason of [undefined as unknown as string, '', '   ']) {
      await expect(h.svc.initiateTicket(SUPER, { ...input, reason })).rejects.toThrowError(/reason required/);
    }
    expect(h.inserted).toEqual([]);
  });

  it('refuses an operator without the initiate capability for that scope', async () => {
    // `support` may initiate a single-player comp but not a server-wide broadcast.
    const h = harness();
    await expect(h.svc.initiateTicket(SUPPORT, { ...input, scope: 'global' })).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    expect(h.inserted).toEqual([]);
  });

  it('stores a single-player ticket as pending with the attachment-derived tier', async () => {
    const h = harness();
    const view = await h.svc.initiateTicket(SUPER, { ...input, reason: '  crash refund  ' });
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toMatchObject({
      scope: 'single',
      target: { publicId: '123456789' },
      reason: 'crash refund',
      status: 'pending',
      initiatedBy: 'adm-1',
      initiatedAt: NOW,
    });
    expect(h.inserted[0]!.dispatchKey).toBeTruthy();
    expect(view).toMatchObject({ id: h.inserted[0]!._id, status: 'pending' });
    expect(h.audits[0]).toMatchObject({ action: 'comp.initiate', summary: expect.stringContaining('single #123456789') });
  });

  // A global compensation is always over quota regardless of what it attaches — the capability is
  // decided by scope, and the tier is what the audit trail records about it.
  it('forces amountTier=overquota for a global ticket and rewrites the target to the "all" filter', async () => {
    const h = harness();
    await h.svc.initiateTicket(SUPER, { ...input, scope: 'global', mail: { ...MAIL, attachments: [] } });
    expect(h.inserted[0]).toMatchObject({ scope: 'global', amountTier: 'overquota', target: { filter: { kind: 'all' } } });
    expect(h.audits[0]!.summary).toContain('global filter:all');
  });
});

describe('listTickets', () => {
  it('queries unfiltered when no status was given', async () => {
    const h = harness({ list: [TICKET] });
    const rows = await h.svc.listTickets({});
    expect(h.listQueries).toEqual([{}]);
    expect(rows).toHaveLength(1);
  });

  it('rejects a status outside the state machine', async () => {
    const h = harness();
    await expect(h.svc.listTickets({ status: 'archived' })).rejects.toMatchObject({
      status: 400,
      message: 'invalid status',
    });
    expect(h.listQueries).toEqual([]);
  });

  it('passes a valid status through', async () => {
    const h = harness({ list: [] });
    await h.svc.listTickets({ status: 'failed' });
    expect(h.listQueries).toEqual([{ status: 'failed' }]);
  });
});

describe('approveTicket', () => {
  it('404s on an unknown id', async () => {
    await expect(harness({ ticket: null }).svc.approveTicket(SUPER, 't9')).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  it('409s on a ticket that is no longer pending, naming the status it is in', async () => {
    await expect(
      harness({ ticket: { ...TICKET, status: 'executed' } }).svc.approveTicket(SUPER, 't1'),
    ).rejects.toMatchObject({ status: 409, code: 'conflict', message: 'ticket is executed' });
  });

  // Four-eyes: blocked only while somebody else COULD approve. With a second eligible approver on
  // the books the initiator is refused; with none, self-approval is allowed and flagged in the log.
  it('refuses self-approval when another eligible approver exists', async () => {
    const h = harness({ approvers: 1 });
    await expect(h.svc.approveTicket(SUPER, 't1')).rejects.toMatchObject({
      status: 403,
      message: 'initiator cannot approve own ticket',
    });
    expect(h.sent).toEqual([]);
  });

  it('allows self-approval when nobody else can approve, and flags it in the audit summary', async () => {
    const h = harness({ approvers: 0 });
    await h.svc.approveTicket(SUPER, 't1');
    expect(h.audits.map((a) => a.action)).toEqual(['comp.approve', 'comp.execute']);
    expect(h.audits[0]!.summary).toBe('single [SELF-APPROVED:no-other-approver]');
  });

  it('records a plain scope summary when a different admin approves', async () => {
    const h = harness();
    await h.svc.approveTicket(OTHER_SUPER, 't1');
    expect(h.audits[0]).toMatchObject({ actor: 'adm-2', action: 'comp.approve', summary: 'single' });
  });

  it('refuses an approver lacking the capability for the ticket scope/tier', async () => {
    const h = harness({ ticket: { ...TICKET, scope: 'global', amountTier: 'overquota' } });
    await expect(h.svc.approveTicket(OPS, 't1')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect(h.cas).toEqual([]);
  });

  // The CAS is the real guard: two operators clicking Approve at the same time both pass the read
  // above, and only the one whose findOneAndUpdate matched `status: 'pending'` may execute.
  it('409s when the status CAS finds the ticket no longer pending', async () => {
    const h = harness({ cas: [null] });
    await expect(h.svc.approveTicket(OTHER_SUPER, 't1')).rejects.toMatchObject({
      status: 409,
      message: 'ticket no longer pending',
    });
    expect(h.sent).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('claims the ticket with a status-guarded filter and then executes it', async () => {
    const h = harness();
    const view = await h.svc.approveTicket(OTHER_SUPER, 't1');
    expect(h.cas[0]).toEqual({
      filter: { _id: 't1', status: 'pending' },
      set: { status: 'approved', approvedBy: 'adm-2', approvedAt: NOW },
    });
    expect(h.sent).toHaveLength(1);
    expect(view).toMatchObject({ status: 'executed', recipientCount: 1 });
  });
});

describe('rejectTicket', () => {
  it('404s on an unknown id and 409s on a non-pending ticket', async () => {
    await expect(harness({ ticket: null }).svc.rejectTicket(SUPER, 't9', 'no')).rejects.toMatchObject({ status: 404 });
    await expect(
      harness({ ticket: { ...TICKET, status: 'cancelled' } }).svc.rejectTicket(SUPER, 't1', 'no'),
    ).rejects.toMatchObject({ status: 409, message: 'ticket is cancelled' });
  });

  // Rejection has no single-approver exception — unlike approval, a deadlock here is harmless
  // (the initiator can just cancel their own ticket).
  it('always refuses the initiator, with no other-approver exception', async () => {
    const h = harness({ approvers: 0 });
    await expect(h.svc.rejectTicket(SUPER, 't1', 'not warranted')).rejects.toMatchObject({
      status: 403,
      message: 'initiator cannot reject own ticket',
    });
  });

  it('409s when the status CAS is lost', async () => {
    const h = harness({ cas: [null] });
    await expect(h.svc.rejectTicket(OTHER_SUPER, 't1', 'no')).rejects.toMatchObject({
      status: 409,
      message: 'ticket no longer pending',
    });
    expect(h.audits).toEqual([]);
  });

  it('stores the note as the error field and audits it as the summary', async () => {
    const h = harness();
    const view = await h.svc.rejectTicket(OTHER_SUPER, 't1', 'duplicate claim');
    expect(h.cas[0]!.set).toEqual({
      status: 'rejected',
      approvedBy: 'adm-2',
      approvedAt: NOW,
      error: 'duplicate claim',
    });
    expect(view).toMatchObject({ status: 'rejected', error: 'duplicate claim' });
    expect(h.audits[0]).toMatchObject({ action: 'comp.reject', target: 't1', summary: 'duplicate claim' });
    expect(h.sent).toEqual([]);
  });
});

describe('cancelTicket', () => {
  it('404s on an unknown id and 409s on a non-pending ticket', async () => {
    await expect(harness({ ticket: null }).svc.cancelTicket(SUPER, 't9')).rejects.toMatchObject({ status: 404 });
    await expect(
      harness({ ticket: { ...TICKET, status: 'rejected' } }).svc.cancelTicket(SUPER, 't1'),
    ).rejects.toMatchObject({ status: 409, message: 'ticket is rejected' });
  });

  it('refuses a third party who is neither the initiator nor a super admin', async () => {
    const h = harness();
    await expect(h.svc.cancelTicket(OPS, 't1')).rejects.toMatchObject({
      status: 403,
      message: 'only initiator or super can cancel',
    });
    expect(h.cas).toEqual([]);
  });

  it('allows the initiator, and allows a super admin who did not initiate it', async () => {
    const byInitiator = harness();
    await byInitiator.svc.cancelTicket(SUPER, 't1');
    expect(byInitiator.cas[0]!.set).toMatchObject({ status: 'cancelled', approvedBy: 'adm-1' });

    const bySuper = harness();
    const view = await bySuper.svc.cancelTicket(OTHER_SUPER, 't1');
    expect(view).toMatchObject({ status: 'cancelled' });
    expect(bySuper.audits[0]).toMatchObject({ action: 'comp.cancel', target: 't1' });
  });

  it('409s when the status CAS is lost', async () => {
    const h = harness({ cas: [null] });
    await expect(h.svc.cancelTicket(SUPER, 't1')).rejects.toMatchObject({
      status: 409,
      message: 'ticket no longer pending',
    });
    expect(h.audits).toEqual([]);
  });
});

describe('preview', () => {
  it('rejects a scope that is neither single nor global', async () => {
    await expect(harness().svc.preview(SUPER, { scope: 'team', target: {} as never })).rejects.toMatchObject({
      status: 400,
      message: 'scope must be single|global',
    });
  });

  // 2026-08-04 fix: preview is a dry run of initiateTicket and must be gated by the same capability
  // — otherwise any authenticated admin could probe the size of a global broadcast.
  it('applies the same initiate capability as the real thing', async () => {
    const h = harness();
    await expect(h.svc.preview(SUPPORT, { scope: 'global', target: {} as never })).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    expect(h.previewed).toEqual([]);
  });

  it('answers a single-player preview locally without calling the mail backend', async () => {
    const h = harness();
    expect(await h.svc.preview(SUPER, { scope: 'single', target: { publicId: '123456789' } })).toEqual({
      recipientCount: 1,
      available: true,
    });
    expect(h.previewed).toEqual([]);
  });

  it('asks the mail backend for a global preview and reports its ok flag as availability', async () => {
    const ok = harness();
    expect(await ok.svc.preview(SUPER, { scope: 'global', target: {} as never })).toEqual({
      recipientCount: 42,
      available: true,
    });
    expect(ok.previewed).toEqual([{ scope: 'global', target: { filter: { kind: 'all' } } }]);

    const down = harness({ mailPreview: { ok: false, recipientCount: 0 } });
    expect(await down.svc.preview(SUPER, { scope: 'global', target: {} as never })).toEqual({
      recipientCount: 0,
      available: false,
    });
  });
});

describe('retryTicket', () => {
  const FAILED: CompTicketDoc = { ...TICKET, status: 'failed', error: 'mail dispatch failed' };

  it('404s on an unknown id', async () => {
    await expect(harness({ ticket: null }).svc.retryTicket(SUPER, 't9')).rejects.toMatchObject({ status: 404 });
  });

  it('409s on any status other than failed', async () => {
    await expect(harness().svc.retryTicket(SUPER, 't1')).rejects.toMatchObject({
      status: 409,
      message: 'ticket is pending',
    });
  });

  it('refuses an operator lacking the approve capability for the ticket', async () => {
    const h = harness({ ticket: { ...FAILED, scope: 'global', amountTier: 'overquota' } });
    await expect(h.svc.retryTicket(OPS, 't1')).rejects.toMatchObject({ status: 403 });
    expect(h.cas).toEqual([]);
  });

  // The claim is what makes a double-click safe: the loser gets 409 instead of a second mail.send.
  it('claims the retry atomically and 409s the caller that loses the claim', async () => {
    const lost = harness({ ticket: FAILED, cas: [null] });
    await expect(lost.svc.retryTicket(SUPER, 't1')).rejects.toMatchObject({
      status: 409,
      message: 'retry already in progress',
    });
    expect(lost.sent).toEqual([]);

    const won = harness({ ticket: FAILED });
    await won.svc.retryTicket(SUPER, 't1');
    expect(won.cas[0]).toEqual({
      filter: { _id: 't1', status: 'failed', retryLockedAt: { $exists: false } },
      set: { retryLockedAt: NOW },
    });
    expect(won.sent).toHaveLength(1);
  });
});

describe('execute (via approveTicket)', () => {
  it('forwards the stored mail content and the ticket dispatchKey', async () => {
    const h = harness();
    await h.svc.approveTicket(OTHER_SUPER, 't1');
    expect(h.sent).toEqual([
      {
        dispatchKey: 'dk-1',
        scope: 'single',
        target: { publicId: '123456789' },
        subject: 'sorry',
        body: 'have some coins',
        attachments: MAIL.attachments,
        expireDays: 30,
      },
    ]);
  });

  it('backfills recipientCount when the backend reported one', async () => {
    const h = harness({ mailSend: { ok: true, recipientCount: 7 } });
    const view = await h.svc.approveTicket(OTHER_SUPER, 't1');
    expect(view).toMatchObject({ status: 'executed', recipientCount: 7 });
    expect(h.audits.at(-1)).toMatchObject({ action: 'comp.execute', summary: 'recipients=7' });
  });

  // A backend that answers ok without a count must not write `recipientCount: undefined` into the
  // document, and the audit line says so with '?' rather than the word "undefined".
  it('omits recipientCount and audits "?" when the backend reported none', async () => {
    const h = harness({ mailSend: { ok: true } });
    const view = await h.svc.approveTicket(OTHER_SUPER, 't1');
    expect(view).not.toHaveProperty('recipientCount');
    expect(h.audits.at(-1)).toMatchObject({ summary: 'recipients=?' });
  });

  it('falls back to the pre-update document when the executed write returns nothing', async () => {
    // First CAS = the approve claim (default behaviour), second = execute's update, stubbed to null.
    const h = harness({ cas: [{ ...TICKET, status: 'approved' }, null] });
    const view = await h.svc.approveTicket(OTHER_SUPER, 't1');
    expect(view).toMatchObject({ id: 't1', status: 'approved' });
    expect(h.audits.at(-1)).toMatchObject({ action: 'comp.execute' });
  });

  it('marks the ticket failed with the backend error and audits comp.execute.failed', async () => {
    const h = harness({ mailSend: { ok: false, error: 'meta 502' } });
    const view = await h.svc.approveTicket(OTHER_SUPER, 't1');
    expect(view).toMatchObject({ status: 'failed', error: 'meta 502' });
    expect(h.cas.at(-1)?.set).toEqual({ status: 'failed', error: 'meta 502' });
    expect(h.audits.at(-1)).toMatchObject({ action: 'comp.execute.failed', target: 't1', summary: 'meta 502' });
  });

  it('substitutes a generic error when the backend failed without saying why', async () => {
    const h = harness({ mailSend: { ok: false } });
    const view = await h.svc.approveTicket(OTHER_SUPER, 't1');
    expect(view).toMatchObject({ status: 'failed', error: 'mail dispatch failed' });
  });

  it('falls back to a synthesised failed document when the failing write returns nothing', async () => {
    const h = harness({ cas: [{ ...TICKET, status: 'approved' }, null], mailSend: { ok: false, error: 'meta 502' } });
    const view = await h.svc.approveTicket(OTHER_SUPER, 't1');
    expect(view).toMatchObject({ id: 't1', status: 'failed', error: 'meta 502' });
  });
});

describe('toTicketView actor names', () => {
  it('omits initiatedByName when the initiator has no admin account document', async () => {
    const h = harness({ list: [TICKET] });
    const [row] = await h.svc.listTickets({});
    expect(row).not.toHaveProperty('initiatedByName');
    expect(row).not.toHaveProperty('approvedBy');
  });

  it('attaches both names once the accounts resolve', async () => {
    const h = harness({
      list: [{ ...TICKET, status: 'executed', approvedBy: 'adm-2', approvedAt: 3, executedAt: 4, recipientCount: 1 }],
      accountRows: [
        { _id: 'adm-1', displayName: 'Root' },
        { _id: 'adm-2', username: 'root2' },
      ],
    });
    const [row] = await h.svc.listTickets({});
    expect(row).toMatchObject({
      initiatedByName: 'Root',
      approvedBy: 'adm-2',
      approvedByName: 'root2', // displayName is empty → falls back to username
      approvedAt: 3,
      executedAt: 4,
      recipientCount: 1,
    });
  });
});
