// Branch-coverage backfill for src/accounts/{resolve,password,oauthBind}.ts (2026-09-03 branch-coverage
// task, group F).
//
// Why this file exists: auth-credential-unit.test.ts / auth-oauthbind-unit.test.ts already drive the
// happy paths and the check-then-refuse paths of these modules, but every "lost race" branch was left
// untaken — and those branches ARE the reason this code looks the way it does (see each function's
// 2026-08-03 comment). An HTTP-level test cannot make two callers hit the same not-yet-existing unique
// key in the same instant; wrapping `updateOne` on one collection can, and that is what the
// ThrowingUpdate/BlindReads doubles below do.
//
// What each race decides for the player: whether a retried device login lands on a *second* account
// (losing their save), whether a concurrent OAuth bind silently steals a credential from another
// account, and whether a duplicate registration reports "taken" or a 500.
import { describe, expect, it } from 'vitest';
import { hashPassword, isAnonymousAccount, type ChatRegion, type Collections } from '@nw/shared';
import { resolveByDevice, resolveByOAuth, resolveByOpenid, touchRegion } from '../src/accounts/resolve.js';
import { bindOAuth, bindPassword } from '../src/accounts/oauthBind.js';
import { registerWithPassword } from '../src/accounts/password.js';
import { FakeCollection } from './helpers/fakeCollection.js';

const TS = 1_700_000_000_000;

interface AccountDoc {
  _id: string;
  createdAt?: number;
  deviceId?: string;
  openid?: string;
  displayName?: string;
  nameChosen?: boolean;
  region?: ChatRegion;
  password?: { loginId: string; hash: string };
  oauth?: { provider: string; sub: string }[];
}

/** updateOne always rejects with a caller-supplied error — the only way to reach the E11000
 *  upsert-race catch blocks (and their non-11000 rethrow) with no real concurrency. */
class ThrowingUpdate extends FakeCollection<AccountDoc> {
  constructor(private readonly toThrow: unknown) { super(); }
  override async updateOne(): Promise<never> { throw this.toThrow; }
}

/** Every findOne answers null while writes still land — models a read routed to a replica-set
 *  secondary that has not yet seen the document this very call just upserted. */
class BlindReads extends FakeCollection<AccountDoc> {
  override async findOne(): Promise<AccountDoc | null> { return null; }
}

function colsFor(accounts: FakeCollection<AccountDoc>): Collections {
  return { accounts } as unknown as Collections;
}

// ── touchRegion ─────────────────────────────────────────────────────────────────────────────────
describe('touchRegion', () => {
  it('a resolved region is written back', async () => {
    const accounts = new FakeCollection<AccountDoc>().seed({ _id: 'a' });
    await touchRegion(colsFor(accounts), 'a', 'cn');
    expect(accounts.docs.get('a')!.region).toBe('cn');
  });

  it('"global" is NOT written back — a request with no Accept-Language must not downgrade an already resolved region', async () => {
    const accounts = new FakeCollection<AccountDoc>().seed({ _id: 'a', region: 'cn' });
    await touchRegion(colsFor(accounts), 'a', 'global');
    expect(accounts.docs.get('a')!.region).toBe('cn');
  });
});

// ── resolveByDevice ─────────────────────────────────────────────────────────────────────────────
describe('resolveByDevice', () => {
  it('existing device -> same account, isNew=false, region touched', async () => {
    const accounts = new FakeCollection<AccountDoc>().seed({ _id: 'acc-d', deviceId: 'dev-1', displayName: 'Wei' });
    const r = await resolveByDevice(colsFor(accounts), 'dev-1', TS, 'cn');
    expect(r).toEqual({ accountId: 'acc-d', isNew: false, isAnonymous: true, displayName: 'Wei' });
    expect(accounts.docs.get('acc-d')!.region).toBe('cn');
  });

  it('existing device with a bound password -> isAnonymous=false (the real value, not the device default)', async () => {
    const accounts = new FakeCollection<AccountDoc>().seed({
      _id: 'acc-d2', deviceId: 'dev-2', password: { loginId: 'x@y.z', hash: 'h' },
    });
    expect((await resolveByDevice(colsFor(accounts), 'dev-2', TS)).isAnonymous).toBe(false);
  });

  it('new device, region=global -> created without a region field (no $set clause emitted)', async () => {
    const accounts = new FakeCollection<AccountDoc>();
    const r = await resolveByDevice(colsFor(accounts), 'dev-new', TS);
    expect(r.isNew).toBe(true);
    expect(r.isAnonymous).toBe(true);
    const doc = accounts.docs.get(r.accountId)!;
    expect(doc.deviceId).toBe('dev-new');
    expect(doc.createdAt).toBe(TS);
    expect(doc.region).toBeUndefined();
  });

  it('new device, resolved region -> the region is stamped on the inserted document', async () => {
    const accounts = new FakeCollection<AccountDoc>();
    const r = await resolveByDevice(colsFor(accounts), 'dev-cn', TS, 'cn');
    expect(accounts.docs.get(r.accountId)!.region).toBe('cn');
  });

  it('lost upsert race (E11000) -> falls through to the re-read and returns the WINNER\'s account', async () => {
    // This is the branch the 2026-08-03 fix exists for: without it a client merely retrying a dropped
    // request gets a 500. With it, both callers converge on one account, so the device keeps one save.
    const accounts = new ThrowingUpdate({ code: 11000 });
    accounts.seed({ _id: 'acc-winner', deviceId: 'dev-race', createdAt: TS - 1 });
    let sawExisting = false;
    // The first read must miss (that is what makes this a race), the re-read must find the winner.
    const orig = accounts.findOne.bind(accounts);
    accounts.findOne = async (q?: Record<string, unknown>) => {
      if (!sawExisting) { sawExisting = true; return null; }
      return orig(q);
    };
    const r = await resolveByDevice(colsFor(accounts), 'dev-race', TS);
    expect(r.accountId).toBe('acc-winner');
    expect(r.isNew).toBe(false);
    expect(r.isAnonymous).toBe(true);
  });

  it('a non-duplicate-key write error is rethrown, not swallowed as "someone else won"', async () => {
    const accounts = new ThrowingUpdate({ code: 121, message: 'document validation failure' });
    await expect(resolveByDevice(colsFor(accounts), 'dev-boom', TS)).rejects.toMatchObject({ code: 121 });
  });

  it('the read-back after a successful upsert comes back empty -> generated id returned, still isNew', async () => {
    // isNew used to degrade to false here (the id comparison had nothing to compare against), so a
    // genuinely new account whose confirming read hit a lagging secondary silently skipped
    // maybeGrantStarterCards — the player started with nothing and no error anywhere. The upsert's own
    // upsertedCount is the evidence that survives a blind read (2026-09-03 fix).
    const accounts = new BlindReads();
    const r = await resolveByDevice(colsFor(accounts), 'dev-blind', TS);
    expect(r.accountId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.isNew).toBe(true);
    expect(r.isAnonymous).toBe(true);
    expect([...accounts.docs.values()][0]!.deviceId).toBe('dev-blind'); // the write itself landed
  });

  it('a LOST upsert race followed by a blind read-back still reports isNew=false', async () => {
    // The other direction of the same fix: nothing was upserted (E11000 — someone else won), so even
    // with the read-back blind this must not claim a fresh account and re-grant starter content.
    const accounts = new ThrowingUpdate({ code: 11000 });
    accounts.findOne = async () => null;
    const r = await resolveByDevice(colsFor(accounts), 'dev-lost-blind', TS);
    expect(r.isNew).toBe(false);
  });
});

// ── resolveByOpenid ─────────────────────────────────────────────────────────────────────────────
describe('resolveByOpenid', () => {
  it('existing openid -> same account, region touched, isAnonymous read off the doc', async () => {
    const accounts = new FakeCollection<AccountDoc>().seed({ _id: 'acc-o', openid: 'oid-1', displayName: 'Li' });
    const r = await resolveByOpenid(colsFor(accounts), 'oid-1', TS, 'cn');
    expect(r).toEqual({ accountId: 'acc-o', isNew: false, isAnonymous: false, displayName: 'Li' });
    expect(accounts.docs.get('acc-o')!.region).toBe('cn');
  });

  it('new openid, region=global -> created with no region; resolved region -> stamped', async () => {
    const plain = new FakeCollection<AccountDoc>();
    const a = await resolveByOpenid(colsFor(plain), 'oid-new', TS);
    expect(a.isNew).toBe(true);
    expect(a.isAnonymous).toBe(false); // WeChat is a recoverable credential
    expect(plain.docs.get(a.accountId)!.region).toBeUndefined();

    const regional = new FakeCollection<AccountDoc>();
    const b = await resolveByOpenid(colsFor(regional), 'oid-cn', TS, 'cn');
    expect(regional.docs.get(b.accountId)!.region).toBe('cn');
  });

  it('lost upsert race (E11000) -> re-read returns the winner instead of a 500', async () => {
    const accounts = new ThrowingUpdate({ code: 11000 });
    accounts.seed({ _id: 'acc-owin', openid: 'oid-race' });
    let first = true;
    const orig = accounts.findOne.bind(accounts);
    accounts.findOne = async (q?: Record<string, unknown>) => {
      if (first) { first = false; return null; }
      return orig(q);
    };
    expect(await resolveByOpenid(colsFor(accounts), 'oid-race', TS)).toEqual({
      accountId: 'acc-owin', isNew: false, isAnonymous: false,
    });
  });

  it('a non-11000 write error is rethrown', async () => {
    const accounts = new ThrowingUpdate({ code: 2 });
    await expect(resolveByOpenid(colsFor(accounts), 'oid-boom', TS)).rejects.toMatchObject({ code: 2 });
  });

  it('blind read-back -> generated id returned, still isNew, still non-anonymous', async () => {
    const accounts = new BlindReads();
    const r = await resolveByOpenid(colsFor(accounts), 'oid-blind', TS);
    expect(r.accountId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.isNew).toBe(true); // see resolveByDevice's blind-read case
    expect(r.isAnonymous).toBe(false);
  });
});

// ── resolveByOAuth ──────────────────────────────────────────────────────────────────────────────
describe('resolveByOAuth', () => {
  it('existing provider+sub -> same account, region touched', async () => {
    const accounts = new FakeCollection<AccountDoc>().seed({
      _id: 'acc-oa', oauth: [{ provider: 'google', sub: 's1' }], displayName: 'Zhao',
    });
    const r = await resolveByOAuth(colsFor(accounts), 'google', 's1', TS, 'cn');
    expect(r).toEqual({ accountId: 'acc-oa', isNew: false, isAnonymous: false, displayName: 'Zhao' });
    expect(accounts.docs.get('acc-oa')!.region).toBe('cn');
  });

  it('new provider+sub, region=global -> no region field; resolved region -> stamped inside $setOnInsert', async () => {
    const plain = new FakeCollection<AccountDoc>();
    const a = await resolveByOAuth(colsFor(plain), 'google', 'new-1', TS);
    expect(a.isNew).toBe(true);
    expect(plain.docs.get(a.accountId)!.oauth).toEqual([{ provider: 'google', sub: 'new-1' }]);
    expect(plain.docs.get(a.accountId)!.region).toBeUndefined();

    const regional = new FakeCollection<AccountDoc>();
    const b = await resolveByOAuth(colsFor(regional), 'google', 'new-2', TS, 'cn');
    expect(regional.docs.get(b.accountId)!.region).toBe('cn');
  });

  it('lost upsert race (E11000) -> re-read returns the winner', async () => {
    const accounts = new ThrowingUpdate({ code: 11000 });
    accounts.seed({ _id: 'acc-oawin', oauth: [{ provider: 'apple', sub: 'race' }] });
    let first = true;
    const orig = accounts.findOne.bind(accounts);
    accounts.findOne = async (q?: Record<string, unknown>) => {
      if (first) { first = false; return null; }
      return orig(q);
    };
    expect(await resolveByOAuth(colsFor(accounts), 'apple', 'race', TS)).toEqual({
      accountId: 'acc-oawin', isNew: false, isAnonymous: false,
    });
  });

  it('a non-11000 write error is rethrown', async () => {
    const accounts = new ThrowingUpdate({ message: 'connection reset' });
    await expect(resolveByOAuth(colsFor(accounts), 'apple', 'boom', TS)).rejects.toMatchObject({ message: 'connection reset' });
  });

  it('blind read-back -> generated id returned, still isNew', async () => {
    const accounts = new BlindReads();
    const r = await resolveByOAuth(colsFor(accounts), 'apple', 'blind', TS);
    expect(r.accountId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.isNew).toBe(true); // see resolveByDevice's blind-read case
    expect(r.isAnonymous).toBe(false);
  });
});

// ── registerWithPassword ────────────────────────────────────────────────────────────────────────
describe('registerWithPassword', () => {
  it('fresh loginId with an explicit name + resolved region -> nameChosen and region are stamped', async () => {
    const accounts = new FakeCollection<AccountDoc>();
    const r = await registerWithPassword(colsFor(accounts), '  Wei@Example.COM ', 'pw-123456', 'Wei', TS, 'cn');
    expect(r.kind).toBe('ok');
    const doc = [...accounts.docs.values()][0]!;
    expect(doc.password!.loginId).toBe('wei@example.com'); // normalized
    expect(doc.displayName).toBe('Wei');
    expect(doc.nameChosen).toBe(true);
    expect(doc.region).toBe('cn');
  });

  it('fresh loginId, no name, region=global -> neither displayName/nameChosen nor region is written', async () => {
    const accounts = new FakeCollection<AccountDoc>();
    const r = await registerWithPassword(colsFor(accounts), 'anon@example.com', 'pw-123456', undefined, TS);
    expect(r.kind).toBe('ok');
    const doc = [...accounts.docs.values()][0]!;
    expect(doc.displayName).toBeUndefined();
    expect(doc.nameChosen).toBeUndefined(); // the free rename stays available
    expect(doc.region).toBeUndefined();
  });

  it('loginId already registered -> taken (upsert matched, nothing inserted, no upsertedId)', async () => {
    const accounts = new FakeCollection<AccountDoc>().seed({
      _id: 'acc-taken', password: { loginId: 'dup@example.com', hash: await hashPassword('other') },
    });
    const r = await registerWithPassword(colsFor(accounts), 'DUP@example.com', 'pw-123456', undefined, TS);
    expect(r.kind).toBe('taken');
    expect(accounts.docs.size).toBe(1); // the existing account was not touched
  });

  it('lost upsert race (E11000) -> taken, which is exactly what losing that race means', async () => {
    const accounts = new ThrowingUpdate({ code: 11000 });
    expect(await registerWithPassword(colsFor(accounts), 'race@example.com', 'pw-123456', undefined, TS))
      .toEqual({ kind: 'taken' });
  });

  it('a non-11000 write error is rethrown (never reported to the user as "taken")', async () => {
    const accounts = new ThrowingUpdate({ code: 13, message: 'unauthorized' });
    await expect(registerWithPassword(colsFor(accounts), 'boom@example.com', 'pw-123456', undefined, TS))
      .rejects.toMatchObject({ code: 13 });
  });
});

// ── bindOAuth ───────────────────────────────────────────────────────────────────────────────────
describe('bindOAuth', () => {
  it('unbound credential -> appended to this account\'s oauth[], which also un-anonymises it', async () => {
    const accounts = new FakeCollection<AccountDoc>().seed({ _id: 'acc-b1', deviceId: 'dev' });
    expect(await bindOAuth(colsFor(accounts), 'acc-b1', 'google', 'g1')).toEqual({ kind: 'ok' });
    const doc = accounts.docs.get('acc-b1')!;
    expect(doc.oauth).toEqual([{ provider: 'google', sub: 'g1' }]);
    expect(isAnonymousAccount(doc as never)).toBe(false);
  });

  it('credential already on THIS account -> ok, idempotent, no second oauth[] entry', async () => {
    const accounts = new FakeCollection<AccountDoc>().seed({
      _id: 'acc-b2', oauth: [{ provider: 'google', sub: 'g2' }],
    });
    expect(await bindOAuth(colsFor(accounts), 'acc-b2', 'google', 'g2')).toEqual({ kind: 'ok' });
    expect(accounts.docs.get('acc-b2')!.oauth).toHaveLength(1);
  });

  it('credential owned by ANOTHER account -> already_bound, and it is not moved', async () => {
    const accounts = new FakeCollection<AccountDoc>().seed(
      { _id: 'acc-owner', oauth: [{ provider: 'google', sub: 'g3' }] },
      { _id: 'acc-thief' },
    );
    expect(await bindOAuth(colsFor(accounts), 'acc-thief', 'google', 'g3')).toEqual({ kind: 'already_bound' });
    expect(accounts.docs.get('acc-thief')!.oauth).toBeUndefined();
    expect(accounts.docs.get('acc-owner')!.oauth).toHaveLength(1);
  });

  it('concurrent bind of the same credential elsewhere (E11000 on write) -> already_bound, not a 500', async () => {
    // The check-then-write window: `existing` was read before either write landed, so the compound
    // (provider,sub) unique index is the only thing left to catch the loser.
    const accounts = new ThrowingUpdate({ code: 11000 });
    expect(await bindOAuth(colsFor(accounts), 'acc-loser', 'google', 'g4')).toEqual({ kind: 'already_bound' });
  });

  it('a non-11000 write error is rethrown', async () => {
    const accounts = new ThrowingUpdate({ code: 50, message: 'exceeded time limit' });
    await expect(bindOAuth(colsFor(accounts), 'acc-x', 'google', 'g5')).rejects.toMatchObject({ code: 50 });
  });
});

// ── bindPassword ────────────────────────────────────────────────────────────────────────────────
describe('bindPassword', () => {
  it('free loginId -> hash written onto this account', async () => {
    const accounts = new FakeCollection<AccountDoc>().seed({ _id: 'acc-p1', deviceId: 'dev' });
    expect(await bindPassword(colsFor(accounts), 'acc-p1', ' New@Example.com ', 'pw-123456')).toEqual({ kind: 'ok' });
    expect(accounts.docs.get('acc-p1')!.password!.loginId).toBe('new@example.com');
    expect(accounts.docs.get('acc-p1')!.password!.hash).toBeTruthy();
  });

  it('account already has a password -> ok without overwriting it (change goes through /auth/password/change)', async () => {
    const accounts = new FakeCollection<AccountDoc>().seed({
      _id: 'acc-p2', password: { loginId: 'kept@example.com', hash: 'original-hash' },
    });
    expect(await bindPassword(colsFor(accounts), 'acc-p2', 'other@example.com', 'pw-123456')).toEqual({ kind: 'ok' });
    expect(accounts.docs.get('acc-p2')!.password).toEqual({ loginId: 'kept@example.com', hash: 'original-hash' });
  });

  it('loginId owned by another account -> login_id_taken, nothing written', async () => {
    const accounts = new FakeCollection<AccountDoc>().seed(
      { _id: 'acc-owner', password: { loginId: 'mine@example.com', hash: 'h' } },
      { _id: 'acc-p3' },
    );
    expect(await bindPassword(colsFor(accounts), 'acc-p3', 'MINE@example.com', 'pw-123456')).toEqual({ kind: 'login_id_taken' });
    expect(accounts.docs.get('acc-p3')!.password).toBeUndefined();
  });

  it('concurrent bind of the same loginId elsewhere (E11000 on write) -> login_id_taken, not a 500', async () => {
    const accounts = new ThrowingUpdate({ code: 11000 });
    expect(await bindPassword(colsFor(accounts), 'acc-p4', 'race@example.com', 'pw-123456')).toEqual({ kind: 'login_id_taken' });
  });

  it('a non-11000 write error is rethrown', async () => {
    const accounts = new ThrowingUpdate({ code: 89, message: 'network timeout' });
    await expect(bindPassword(colsFor(accounts), 'acc-p5', 'boom@example.com', 'pw-123456')).rejects.toMatchObject({ code: 89 });
  });
});
