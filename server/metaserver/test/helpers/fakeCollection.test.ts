// Direct unit coverage for fakeCollection.ts itself — the shared FakeCollection double used across
// metaserver's whole test suite. Added 2026-08-14 alongside the upsert/array-match generalization (see
// claudedocs/server.md's 2026-08-14 note): before this, the three fixed behaviors were only exercised
// indirectly through auth-credential-unit.test.ts / auth-oauthbind-unit.test.ts's now-removed
// AccountsFakeCollection wrappers, and the helper itself had zero dedicated tests. Covers:
//  1. updateOne's upsert on a filter without `_id` (deviceId/openid/oauth.*/loginId — the shape every
//     accounts.ts resolveBy*/registerWithPassword upsert uses) seeds the new doc correctly and stores it
//     under its real `_id`, never the Map's `undefined` key.
//  2. updateOne's return value carries `upsertedId` on insert, and omits it on a matched update.
//  3. docMatches groups dotted keys sharing an array-valued prefix (oauth.provider/oauth.sub) and
//     requires them to match the SAME array element — not any element independently.
// Also carries a few pre-existing-behavior regression guards (plain `_id` upsert, non-array dotted path)
// so a future edit here can't silently break what already worked.
import { describe, it, expect } from 'vitest';
import { FakeCollection, docMatches } from './fakeCollection.js';

interface Doc {
  _id: string;
  deviceId?: string;
  oauth?: { provider: string; sub: string }[];
  password?: { loginId: string; hash: string };
  createdAt?: number;
  region?: string;
}

describe('FakeCollection.updateOne upsert', () => {
  it('filter without `_id` seeds the new doc from $setOnInsert and stores it under the real _id, not `undefined`', async () => {
    const col = new FakeCollection<Doc>();
    const res = await col.updateOne(
      { deviceId: 'device-1' },
      { $setOnInsert: { _id: 'acc-1', deviceId: 'device-1', createdAt: 1000 } },
      { upsert: true },
    );
    expect(res).toEqual({ matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: 'acc-1' });
    expect([...col.docs.keys()]).toEqual(['acc-1']);
    // the single-key findOne({_id}) fast path — the exact lookup shape ensurePublicId/rejectIfBanned rely on
    await expect(col.findOne({ _id: 'acc-1' })).resolves.toEqual({ _id: 'acc-1', deviceId: 'device-1', createdAt: 1000 });
  });

  it('a second upsert on the same non-`_id` filter matches the existing doc: matchedCount/modifiedCount=1, no upsertedId, $setOnInsert not reapplied', async () => {
    const col = new FakeCollection<Doc>();
    await col.updateOne({ deviceId: 'device-2' }, { $setOnInsert: { _id: 'acc-2', deviceId: 'device-2' } }, { upsert: true });
    const res = await col.updateOne(
      { deviceId: 'device-2' },
      { $setOnInsert: { _id: 'should-not-apply' }, $set: { region: 'cn' } },
      { upsert: true },
    );
    expect(res).toEqual({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0 });
    expect(res).not.toHaveProperty('upsertedId');
    const doc = await col.findOne({ _id: 'acc-2' });
    expect(doc?.region).toBe('cn');
    expect(doc?._id).toBe('acc-2');
  });

  it('no match and no upsert option → all counts 0, doc not created', async () => {
    const col = new FakeCollection<Doc>();
    const res = await col.updateOne({ deviceId: 'nope' }, { $set: { region: 'cn' } });
    expect(res).toEqual({ matchedCount: 0, modifiedCount: 0, upsertedCount: 0 });
    expect(col.docs.size).toBe(0);
  });

  it('upsert with no `_id` anywhere (filter nor $setOnInsert) still lands under a real generated id, never `undefined`', async () => {
    const col = new FakeCollection<Doc>();
    const res = await col.updateOne({ deviceId: 'device-3' }, { $set: { region: 'cn' } }, { upsert: true });
    expect(res.upsertedCount).toBe(1);
    expect(typeof res.upsertedId).toBe('string');
    expect([...col.docs.keys()]).toEqual([res.upsertedId]);
    expect(col.docs.get(res.upsertedId!)?.deviceId).toBe('device-3');
  });

  it('registerWithPassword-style upsert on a dotted filter (password.loginId) + a full $setOnInsert object', async () => {
    const col = new FakeCollection<Doc>();
    const res = await col.updateOne(
      { 'password.loginId': 'alice' },
      { $setOnInsert: { _id: 'acc-pw', createdAt: 1, password: { loginId: 'alice', hash: 'h' } } },
      { upsert: true },
    );
    expect(res.upsertedId).toBe('acc-pw');
    const doc = await col.findOne({ 'password.loginId': 'alice' });
    expect(doc?._id).toBe('acc-pw');
    expect(doc?.password?.hash).toBe('h');
  });

  it('plain `_id`-filter upsert still works exactly as before (regression guard)', async () => {
    const col = new FakeCollection<Doc>();
    const res = await col.updateOne({ _id: 'acc-4' }, { $set: { region: 'de' } }, { upsert: true });
    expect(res).toEqual({ matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: 'acc-4' });
    expect(col.docs.get('acc-4')?.region).toBe('de');
  });
});

describe('docMatches: array-grouped dotted keys', () => {
  it('matches when a single array element satisfies both dotted keys together', () => {
    const doc: Doc = { _id: 'x', oauth: [{ provider: 'google', sub: 'g-1' }, { provider: 'wechat', sub: 'w-1' }] };
    expect(docMatches(doc as unknown as Record<string, unknown>, { 'oauth.provider': 'google', 'oauth.sub': 'g-1' })).toBe(true);
  });

  it('does NOT match when the two conditions are only satisfied by DIFFERENT elements', () => {
    const doc: Doc = { _id: 'x', oauth: [{ provider: 'google', sub: 'g-1' }, { provider: 'wechat', sub: 'w-1' }] };
    expect(docMatches(doc as unknown as Record<string, unknown>, { 'oauth.provider': 'google', 'oauth.sub': 'w-1' })).toBe(false);
  });

  it('no array field on the doc at all → no match, does not throw', () => {
    const doc: Doc = { _id: 'x' };
    expect(docMatches(doc as unknown as Record<string, unknown>, { 'oauth.provider': 'google', 'oauth.sub': 'g-1' })).toBe(false);
  });

  it('a non-array dotted path (password.loginId) still matches via plain getDotted (regression guard)', () => {
    const doc: Doc = { _id: 'x', password: { loginId: 'alice', hash: 'h' } };
    expect(docMatches(doc as unknown as Record<string, unknown>, { 'password.loginId': 'alice' })).toBe(true);
  });

  it('$or combining an array-grouped clause with a non-matching one still resolves correctly', () => {
    const doc: Doc = { _id: 'x', oauth: [{ provider: 'google', sub: 'g-1' }] };
    expect(
      docMatches(doc as unknown as Record<string, unknown>, {
        $or: [
          { 'oauth.provider': 'wechat', 'oauth.sub': 'w-1' },
          { 'oauth.provider': 'google', 'oauth.sub': 'g-1' },
        ],
      }),
    ).toBe(true);
  });
});

describe('FakeCollection end-to-end: oauth-bound account upsert then lookup (both fixes together)', () => {
  it('upserts by oauth.provider+oauth.sub, then finds the same doc both by that filter and by _id', async () => {
    const col = new FakeCollection<Doc>();
    const insert = await col.updateOne(
      { 'oauth.provider': 'google', 'oauth.sub': 'sub-1' },
      { $setOnInsert: { _id: 'acc-oauth', createdAt: 1, oauth: [{ provider: 'google', sub: 'sub-1' }] } },
      { upsert: true },
    );
    expect(insert.upsertedId).toBe('acc-oauth');

    const byOauth = await col.findOne({ 'oauth.provider': 'google', 'oauth.sub': 'sub-1' });
    expect(byOauth?._id).toBe('acc-oauth');

    const byId = await col.findOne({ _id: 'acc-oauth' });
    expect(byId?._id).toBe('acc-oauth');

    // a repeat upsert with the same oauth pair matches the existing doc instead of creating a second one
    const repeat = await col.updateOne(
      { 'oauth.provider': 'google', 'oauth.sub': 'sub-1' },
      { $setOnInsert: { _id: 'should-not-be-used' } },
      { upsert: true },
    );
    expect(repeat).toEqual({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0 });
    expect(col.docs.size).toBe(1);
  });
});
