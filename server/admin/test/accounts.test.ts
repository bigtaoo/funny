// AccountsService input-validation and self-protection branches (admin.manage).
//
// Why this file exists (2026-09-03 branch-coverage pass): accounts.ts printed 94% lines / 50%
// branches — the worst branch figure of the DB-backed domains. httpRoutes.e2e.test.ts drives the
// four endpoints, but always with a complete, well-formed body, so half of what this module does
// had never executed: the `?? ''` fallbacks that exist because httpApi forwards the parsed JSON
// body verbatim (any field can simply be absent), the duplicate-username race handler, the
// displayName fallback chain, the empty-patch short circuit, and — the two that actually matter —
// the guards that stop a super admin locking every operator out of account management by demoting
// or disabling themselves.
//
// Stubbed collection rather than Mongo: every branch here is decided before or around a single
// findOne/insertOne/updateOne, and the real driver is already covered by the e2e suites. The
// duplicate-key path in particular is only reachable through a stub — provoking a genuine
// concurrent unique-index violation is not something an e2e test can do deterministically.
import { describe, expect, it } from 'vitest';
import { verifyPassword } from '@nw/shared';
import type { AdminAccountDoc } from '../src/db';
import type { AccountsService } from '../src/service/accounts';
import type { Actor } from '../src/service/base';
import { AdminError } from '../src/service/errors';
import { domain, stubDeps, NOW } from './stubDeps';

const ACTOR: Actor = { adminId: 'adm-1', username: 'root', displayName: 'Root', role: 'super' };
const PASSWORD = 'hunter2!';

const OTHER: AdminAccountDoc = {
  _id: 'adm-2',
  username: 'opsguy',
  passwordHash: 'x',
  role: 'ops',
  displayName: 'Ops Guy',
  disabled: false,
  createdAt: 5,
};

interface Harness {
  svc: AccountsService;
  audits: Array<{ action: string; target?: string; summary?: string }>;
  inserted: AdminAccountDoc[];
  updates: Array<Record<string, unknown>>;
}

/**
 * @param found  what `findOne` yields (an existing account, or null for "no such account")
 * @param insertError  thrown by `insertOne` — used for the unique-index race branch
 */
function harness(found: AdminAccountDoc | null = null, insertError?: unknown): Harness {
  const inserted: AdminAccountDoc[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const { deps, audits } = stubDeps({
    cols: {
      adminAccounts: {
        findOne: async () => found,
        insertOne: async (doc: AdminAccountDoc) => {
          if (insertError) throw insertError;
          inserted.push(doc);
          return { acknowledged: true };
        },
        updateOne: async (_filter: unknown, update: { $set: Record<string, unknown> }) => {
          updates.push(update.$set);
          return { acknowledged: true, matchedCount: 1 };
        },
        find: () => ({ sort: () => ({ toArray: async () => (found ? [found] : []) }) }),
      },
    },
  });
  return { svc: domain<AccountsService>(deps, 'accounts'), audits, inserted, updates };
}

describe('listAccounts', () => {
  it('maps every document through the account view (no passwordHash reaches the caller)', async () => {
    const rows = await harness(OTHER).svc.listAccounts();
    expect(rows).toEqual([
      { id: 'adm-2', username: 'opsguy', role: 'ops', displayName: 'Ops Guy', disabled: false, createdAt: 5 },
    ]);
  });
});

describe('createAccount input validation', () => {
  const input = { username: 'newops', password: PASSWORD, role: 'ops', displayName: 'New Ops' };

  it('rejects a missing, short, or whitespace-padded-to-short username', async () => {
    const h = harness();
    for (const username of [undefined as unknown as string, '', 'ab', '  a  ']) {
      await expect(h.svc.createAccount(ACTOR, { ...input, username })).rejects.toMatchObject({
        status: 400,
        code: 'bad_request',
      });
    }
    expect(h.inserted).toEqual([]);
  });

  it('rejects a role outside the four admin roles', async () => {
    const h = harness();
    for (const role of ['admin', 'SUPER', '', undefined as unknown as string]) {
      await expect(h.svc.createAccount(ACTOR, { ...input, role })).rejects.toThrowError(/invalid role/);
    }
  });

  it('rejects a password shorter than the shared minimum, and surfaces the shared validator message', async () => {
    await expect(harness().svc.createAccount(ACTOR, { ...input, password: 'abc' })).rejects.toMatchObject({
      status: 400,
      message: 'password too short (min 6)',
    });
  });

  it('rejects an already-taken username with 409 before hashing or inserting anything', async () => {
    const h = harness(OTHER);
    await expect(h.svc.createAccount(ACTOR, { ...input, username: 'opsguy' })).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
    expect(h.inserted).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  // The pre-check above loses a race between two operators creating the same username at once; the
  // unique index is the real guarantee, and its error has to become the same 409 rather than a 500.
  it('turns a concurrent unique-index violation (code 11000) into the same 409 conflict', async () => {
    const h = harness(null, { code: 11000 });
    await expect(h.svc.createAccount(ACTOR, input)).rejects.toMatchObject({ status: 409, code: 'conflict' });
    await expect(h.svc.createAccount(ACTOR, input)).rejects.toBeInstanceOf(AdminError);
    expect(h.audits).toEqual([]);
  });

  it('rethrows any other insert failure untouched, so a real DB fault is not reported as a name clash', async () => {
    const boom = Object.assign(new Error('connection reset'), { code: 6 });
    await expect(harness(null, boom).svc.createAccount(ACTOR, input)).rejects.toBe(boom);
  });
});

describe('createAccount document assembly', () => {
  const input = { username: '  newops  ', password: PASSWORD, role: 'ops', displayName: 'New Ops' };

  it('trims the username, hashes the password, and stamps createdAt/createdBy from the core', async () => {
    const h = harness();
    const view = await h.svc.createAccount(ACTOR, input);
    expect(h.inserted).toHaveLength(1);
    const doc = h.inserted[0]!;
    expect(doc.username).toBe('newops');
    expect(doc.passwordHash).not.toBe(PASSWORD);
    expect(await verifyPassword(PASSWORD, doc.passwordHash)).toBe(true);
    expect(doc).toMatchObject({ role: 'ops', disabled: false, createdAt: NOW, createdBy: 'adm-1' });
    expect(view).toMatchObject({ id: doc._id, username: 'newops', createdBy: 'adm-1' });
    expect(view).not.toHaveProperty('passwordHash');
  });

  it('falls back to the username as displayName when it is absent or blank', async () => {
    for (const displayName of [undefined as unknown as string, '', '   ']) {
      const h = harness();
      await h.svc.createAccount(ACTOR, { ...input, displayName });
      expect(h.inserted[0]!.displayName).toBe('newops');
    }
  });

  it('trims a supplied displayName', async () => {
    const h = harness();
    await h.svc.createAccount(ACTOR, { ...input, displayName: '  New Ops  ' });
    expect(h.inserted[0]!.displayName).toBe('New Ops');
  });

  it('audits account.create with the username and role', async () => {
    const h = harness();
    await h.svc.createAccount(ACTOR, input);
    expect(h.audits).toEqual([
      expect.objectContaining({ action: 'account.create', summary: 'newops (ops)' }),
    ]);
  });
});

describe('updateAccount', () => {
  it('404s on an unknown id', async () => {
    await expect(harness(null).svc.updateAccount(ACTOR, 'nope', { role: 'ops' })).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });

  it('rejects an invalid role', async () => {
    await expect(harness(OTHER).svc.updateAccount(ACTOR, 'adm-2', { role: 'root' })).rejects.toThrowError(
      /invalid role/,
    );
  });

  // Self-protection: a super admin who demotes or disables themselves can leave a deployment with
  // nobody able to manage accounts at all — there is no recovery path short of editing Mongo.
  it('refuses to let an actor demote themselves out of super, but allows super → super', async () => {
    const self: AdminAccountDoc = { ...OTHER, _id: 'adm-1', username: 'root', role: 'super' };
    await expect(harness(self).svc.updateAccount(ACTOR, 'adm-1', { role: 'ops' })).rejects.toThrowError(
      /cannot demote yourself/,
    );
    const h = harness(self);
    await expect(h.svc.updateAccount(ACTOR, 'adm-1', { role: 'super' })).resolves.toMatchObject({ role: 'super' });
    expect(h.updates).toEqual([{ role: 'super' }]);
  });

  it('refuses to let an actor disable themselves, but allows re-enabling themselves', async () => {
    const self: AdminAccountDoc = { ...OTHER, _id: 'adm-1', username: 'root', role: 'super', disabled: true };
    await expect(harness(self).svc.updateAccount(ACTOR, 'adm-1', { disabled: true })).rejects.toThrowError(
      /cannot disable yourself/,
    );
    const h = harness(self);
    await h.svc.updateAccount(ACTOR, 'adm-1', { disabled: false });
    expect(h.updates).toEqual([{ disabled: false }]);
  });

  it('demoting or disabling somebody else is allowed', async () => {
    const h = harness(OTHER);
    await h.svc.updateAccount(ACTOR, 'adm-2', { role: 'viewer', disabled: true });
    expect(h.updates).toEqual([{ role: 'viewer', disabled: true }]);
  });

  it('ignores a blank displayName instead of wiping the stored one', async () => {
    const h = harness(OTHER);
    const view = await h.svc.updateAccount(ACTOR, 'adm-2', { displayName: '   ' });
    expect(view.displayName).toBe('Ops Guy');
    // Nothing survived the patch, so this collapses into the no-op branch below.
    expect(h.updates).toEqual([]);
  });

  it('trims a supplied displayName', async () => {
    const h = harness(OTHER);
    await h.svc.updateAccount(ACTOR, 'adm-2', { displayName: '  Renamed  ' });
    expect(h.updates).toEqual([{ displayName: 'Renamed' }]);
  });

  // An empty patch must not write an audit row: `account.update` with an empty summary in the log
  // would read as "somebody changed this account" when nothing changed.
  it('short-circuits an empty patch: no write, no audit, current view returned', async () => {
    const h = harness(OTHER);
    const view = await h.svc.updateAccount(ACTOR, 'adm-2', {});
    expect(view).toMatchObject({ id: 'adm-2', role: 'ops' });
    expect(h.updates).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('audits the applied $set and returns the merged view', async () => {
    const h = harness(OTHER);
    const view = await h.svc.updateAccount(ACTOR, 'adm-2', { role: 'support' });
    expect(view).toMatchObject({ id: 'adm-2', role: 'support' });
    expect(h.audits).toEqual([
      expect.objectContaining({ action: 'account.update', target: 'adm-2', summary: '{"role":"support"}' }),
    ]);
  });
});

describe('resetPassword', () => {
  it('validates the new password before looking the account up', async () => {
    const h = harness(null);
    await expect(h.svc.resetPassword(ACTOR, 'adm-2', 'short')).rejects.toMatchObject({
      status: 400,
      message: 'password too short (min 6)',
    });
    expect(h.updates).toEqual([]);
  });

  it('404s on an unknown id, without writing anything', async () => {
    const h = harness(null);
    await expect(h.svc.resetPassword(ACTOR, 'nope', PASSWORD)).rejects.toMatchObject({ status: 404 });
    expect(h.updates).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('stores a verifiable hash of the new password and audits the reset', async () => {
    const h = harness(OTHER);
    await h.svc.resetPassword(ACTOR, 'adm-2', PASSWORD);
    expect(h.updates).toHaveLength(1);
    const hash = h.updates[0]!.passwordHash as string;
    expect(hash).not.toBe(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(h.audits).toEqual([
      expect.objectContaining({ action: 'account.reset_password', target: 'adm-2' }),
    ]);
  });
});
