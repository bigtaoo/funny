// Starter-title grant e2e (TITLE_DESIGN §6): every account owns the newbie title.
// Covers new accounts (seeded by makeNewSave) and the lazy backfill on GET /save for pre-existing
// accounts created before the starter grant was wired — including that the backfill never steals the
// equipped slot from a title the player actually earned.
// Requires `cd server && docker compose up -d` + `tsc -b` first (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, makeNewSave, ladderTitleId, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';
import { grantTitleToPlayer } from '../dist/titles.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_starter_title_test';
const jwt: JwtConfig = { secret: 'test-secret' };
const KEY = 'k';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[starter-title.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('starter title grant e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  const body = (r: { payload: string }) => JSON.parse(r.payload);

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    // commercial omitted (unavailable) — GET /save skips wallet reconcile, exercising the grant path only.
    app = await buildApp({ cols: m.collections, jwt, internalKey: KEY });
  });

  afterAll(async () => { if (app) await app.close(); });

  async function authDevice(deviceId: string) {
    const r = await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId } });
    return body(r).data as { token: string; accountId: string };
  }
  const getSave = async (token: string) =>
    body(await app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${token}` } })).data;

  it('a brand-new account owns + wears the newbie title on first GET /save', async () => {
    const { token } = await authDevice('starter-dev-1');
    const save = await getSave(token);
    expect(save.save.titles).toContain('event.newbie');
    expect(save.save.equipped.title).toBe('event.newbie');
    // ITEM_IDENTITY_DESIGN.md task3 (2026-08-10): makeNewSave stamps titleGrants alongside titles.
    expect(typeof save.save.titleGrants?.['event.newbie']).toBe('number');
  });

  it('backfills a pre-existing account that lacks the title, and auto-equips it when nothing is worn', async () => {
    const { token, accountId } = await authDevice('starter-dev-2');
    // Simulate a legacy save with no titles at all (created before the grant was wired).
    const legacy = makeNewSave(accountId, 1000);
    delete (legacy as { titles?: string[] }).titles;
    delete (legacy as { equipped?: Record<string, string> }).equipped;
    (legacy as { equipped: Record<string, string> }).equipped = {};
    await m.collections.saves.updateOne({ _id: accountId }, { $set: { save: legacy, rev: legacy.rev } });

    const save = await getSave(token);
    expect(save.save.titles).toContain('event.newbie');
    expect(save.save.equipped.title).toBe('event.newbie');
  });

  it('backfill does NOT steal the equipped slot from an earned higher title', async () => {
    const { token, accountId } = await authDevice('starter-dev-3');
    const legacy = makeNewSave(accountId, 1000);
    // Legacy account that earned a ladder king title and is wearing it; owns no newbie yet.
    const king = ladderTitleId(3, 'king'); // weight 5000 >> newbie 1300
    (legacy as { titles: string[] }).titles = [king];
    (legacy as { equipped: Record<string, string> }).equipped = { title: king };
    await m.collections.saves.updateOne({ _id: accountId }, { $set: { save: legacy, rev: legacy.rev } });

    const save = await getSave(token);
    expect(save.save.titles).toEqual(expect.arrayContaining([king, 'event.newbie']));
    expect(save.save.equipped.title).toBe(king); // stays on the earned title
  });

  it('is idempotent across repeated logins (no duplicate entries)', async () => {
    const { token } = await authDevice('starter-dev-4');
    await getSave(token);
    const save = await getSave(token);
    const count = (save.save.titles as string[]).filter((t) => t === 'event.newbie').length;
    expect(count).toBe(1);
  });

  it('regression (2026-08-03 fix): grantTitleToPlayer survives a competing save write queued from a pre-grant snapshot', async () => {
    // Root cause: grantTitleToPlayer used to write via a raw updateOne with no rev guard AND without ever
    // bumping `rev` itself — unlike every other save mutation. Deterministically reproduce the exact
    // failure window: a concurrent request (e.g. a client's own mutateSave-style write) reads a pre-grant
    // snapshot *before* the title lands, then commits its own rev-matched full-document $set *after* the
    // title lands. Against the old code, grantTitleToPlayer never touched rev, so the competing write's
    // rev guard still matched post-grant and its stale, title-less snapshot silently clobbered the grant.
    // (A bare Promise.all of the two calls is not reliable here — MongoDB's real ordering of two
    // near-simultaneous single-document writes can coincidentally land title-grant-last even on the buggy
    // code, making the test pass without proving anything; this reproduces the specific interleaving that
    // actually breaks, not just "the two calls overlap.")
    const { token, accountId } = await authDevice('starter-dev-titlerace');
    await getSave(token); // ensure the save document exists

    // Snapshot taken BEFORE the grant — simulates a concurrent request's own stale read.
    const staleSnapshot = (await m.collections.saves.findOne({ _id: accountId }))!;

    await grantTitleToPlayer(m.collections, accountId, 'event.concurrent_test', Date.now());

    // The competing write's queued commit, built from the pre-grant snapshot, landing AFTER the grant.
    const next = { ...staleSnapshot.save, rev: staleSnapshot.save.rev + 1, updatedAt: Date.now(), flags: { ...staleSnapshot.save.flags, raced: true } };
    const competingRes = await m.collections.saves.findOneAndUpdate(
      { _id: accountId, rev: staleSnapshot.rev },
      { $set: { save: next, rev: next.rev } },
    );

    const doc = await m.collections.saves.findOne({ _id: accountId });
    if (!competingRes) {
      // Fixed behavior: grantTitleToPlayer bumped rev, so the competing write's stale rev guard no longer
      // matches — it must re-read and retry, this time seeing (and preserving) the granted title.
      const retryNext = { ...doc!.save, rev: doc!.save.rev + 1, updatedAt: Date.now(), flags: { ...doc!.save.flags, raced: true } };
      await m.collections.saves.findOneAndUpdate({ _id: accountId, rev: doc!.rev }, { $set: { save: retryNext, rev: retryNext.rev } });
    }
    const finalDoc = await m.collections.saves.findOne({ _id: accountId });
    expect(finalDoc?.save.titles).toContain('event.concurrent_test'); // title survives regardless of which write "won" the race
    expect(finalDoc?.save.flags?.raced).toBe(true); // competing write's change also survives
  });

  // ── titleGrants (ITEM_IDENTITY_DESIGN.md task3, 2026-08-10) ─────────────────────────────

  it('grantTitleToPlayer stamps titleGrants[titleId] with the grant time it is called with', async () => {
    const { token, accountId } = await authDevice('starter-dev-titlegrant-1');
    await getSave(token); // ensure the save document exists
    const grantAt = 1_700_000_000_000;
    await grantTitleToPlayer(m.collections, accountId, 'ach.pvp.veteran', grantAt);

    const doc = await m.collections.saves.findOne({ _id: accountId });
    expect(doc?.save.titles).toContain('ach.pvp.veteran');
    expect(doc?.save.titleGrants?.['ach.pvp.veteran']).toBe(grantAt);
  });

  it('a legacy save with titles but no titleGrants field does not crash, and only the newly granted title gets an obtainedAt', async () => {
    const { token, accountId } = await authDevice('starter-dev-titlegrant-legacy');
    const legacy = makeNewSave(accountId, 1000);
    // Simulate a save created before task3 shipped: titles[] exists, titleGrants does not.
    (legacy as { titles: string[] }).titles = ['event.newbie'];
    delete (legacy as { titleGrants?: Record<string, number> }).titleGrants;
    await m.collections.saves.updateOne({ _id: accountId }, { $set: { save: legacy, rev: legacy.rev } });

    await getSave(token); // sanity: reading the legacy save doesn't crash
    const grantAt = 1_700_000_001_000;
    await grantTitleToPlayer(m.collections, accountId, 'event.founder', grantAt);

    const doc = await m.collections.saves.findOne({ _id: accountId });
    expect(doc?.save.titles).toEqual(expect.arrayContaining(['event.newbie', 'event.founder']));
    // Only the newly granted title has a recorded obtainedAt; the pre-existing 'event.newbie' from the
    // legacy save is not retroactively backfilled (expected — see ITEM_IDENTITY_DESIGN.md §3 task3).
    expect(doc?.save.titleGrants?.['event.founder']).toBe(grantAt);
    expect(doc?.save.titleGrants?.['event.newbie']).toBeUndefined();
  });

  it('re-granting an already-owned title is idempotent: titleGrants keeps the original obtainedAt, not the second call\'s', async () => {
    const { token, accountId } = await authDevice('starter-dev-titlegrant-idem');
    await getSave(token);
    const firstAt = 1_700_000_002_000;
    const secondAt = 1_700_000_099_000; // much later — must NOT overwrite firstAt
    await grantTitleToPlayer(m.collections, accountId, 'ach.all_chapters', firstAt);
    await grantTitleToPlayer(m.collections, accountId, 'ach.all_chapters', secondAt);

    const doc = await m.collections.saves.findOne({ _id: accountId });
    expect((doc?.save.titles as string[]).filter((t) => t === 'ach.all_chapters')).toHaveLength(1);
    expect(doc?.save.titleGrants?.['ach.all_chapters']).toBe(firstAt);
  });

  it('two different titleIds granted concurrently to the same account both land — the rev-guard retry loop (up to 4 attempts) does not let one grant silently drop the other\'s titleGrants entry', async () => {
    // Unlike the single-writer tests above, this fires both grantTitleToPlayer calls via a real Promise.all
    // against real Mongo so the two requests' findOne/findOneAndUpdate round-trips genuinely interleave
    // (a fake in-memory collection can't reproduce this honestly — see titles.test.ts's comment on why that
    // file only covers the purely-sequential and always-conflicting branches). With just two concurrent
    // writers, the loser of the first rev race is guaranteed to succeed on its own retry (re-reading the
    // winner's committed doc), well within the 4-attempt budget.
    const { token, accountId } = await authDevice('starter-dev-titlegrant-concurrent');
    await getSave(token); // ensure the save document exists

    await Promise.all([
      grantTitleToPlayer(m.collections, accountId, 'race.title.a', 3_000_000_000_000),
      grantTitleToPlayer(m.collections, accountId, 'race.title.b', 3_000_000_000_001),
    ]);

    const doc = await m.collections.saves.findOne({ _id: accountId });
    expect(doc?.save.titles).toEqual(expect.arrayContaining(['race.title.a', 'race.title.b']));
    expect(doc?.save.titleGrants?.['race.title.a']).toBe(3_000_000_000_000);
    expect(doc?.save.titleGrants?.['race.title.b']).toBe(3_000_000_000_001);
  });
});
