// Coverage for server/metaserver/scripts/migrateCardInv.ts (2026-07-29 addition, prompted by the
// CC-16 production incident — see CHARACTER_CARDS_DESIGN.md — where this exact script never ran
// against prod and every account's pre-cutover cards stayed unreachable via `cardInstances`). The
// script itself had zero test coverage before this file: its logic was correct (confirmed by a
// manual --dry-run against prod during the incident), but "correct today" isn't the same as "stays
// correct across future edits" — this locks down its idempotency/resumability/rev-guard behavior.
//
// migrateOneAccount is exported with an explicit `dryRun` param (not the module-level DRY_RUN
// constant driven by process.argv) specifically so it can be driven directly from a test — see the
// isMain guard at the bottom of migrateCardInv.ts, mirroring samplePvpReplays.ts's pattern.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type MongoHandle } from '@nw/shared';
import type { Collection, Document } from 'mongodb';
import { migrateOneAccount, type CardInstanceLike } from '../scripts/migrateCardInv.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_migrate_cardinv_test';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[migrateCardInv.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('migrateCardInv (CC-16 migration script)', () => {
  const m = mongo!;
  let saves: Collection<Document>;
  let cardInstances: Collection<Document>;

  function card(id: string, defId = 'lichuang'): CardInstanceLike {
    return { id, defId, level: 1, gear: {}, locked: false };
  }

  async function seedAccount(accountId: string, cardInv: Record<string, CardInstanceLike>, rev = 1): Promise<void> {
    await saves.insertOne({ _id: accountId, rev, save: { cardInv } });
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    saves = m.db.collection<Document>('saves');
    cardInstances = m.db.collection<Document>('cardInstances');
  });

  afterAll(async () => { if (mongo) await mongo.close(); });

  it('dry-run reports the count and writes nothing', async () => {
    await seedAccount('acc1', { c1: card('c1'), c2: card('c2') });

    const r = await migrateOneAccount(saves, cardInstances, 'acc1', true);

    expect(r).toEqual({ ok: true, count: 2 });
    expect(await cardInstances.countDocuments({})).toBe(0);
    const doc = await saves.findOne({ _id: 'acc1' });
    expect(doc!.save.cardInv).toBeDefined();
    expect(Object.keys(doc!.save.cardInv)).toHaveLength(2);
  });

  it('a real run migrates every card and unsets the embedded field', async () => {
    await seedAccount('acc1', { c1: card('c1', 'lichuang'), c2: card('c2', 'chenshou') });

    const r = await migrateOneAccount(saves, cardInstances, 'acc1', false);

    expect(r).toEqual({ ok: true, count: 2 });
    const docs = await cardInstances.find({ accountId: 'acc1' }).toArray();
    expect(docs.map((d) => d._id).sort()).toEqual(['c1', 'c2']);
    expect(docs.find((d) => d._id === 'c1')!.defId).toBe('lichuang');

    const saveDoc = await saves.findOne({ _id: 'acc1' });
    expect(saveDoc!.save.cardInv).toBeUndefined();
    expect(saveDoc!.save.cardInvCount).toBe(2);
    expect(saveDoc!.rev).toBe(2); // $inc: rev 1 → 2
  });

  it('resuming the whole scan afterward is a no-op (the $exists filter is both queue and done-marker)', async () => {
    await seedAccount('acc1', { c1: card('c1') });
    await migrateOneAccount(saves, cardInstances, 'acc1', false);

    // Mirrors main()'s own resumability filter: a second full scan finds nothing left to do.
    const stillPending = await saves.countDocuments({ 'save.cardInv': { $exists: true } });
    expect(stillPending).toBe(0);
    expect(await cardInstances.countDocuments({ accountId: 'acc1' })).toBe(1); // not duplicated
  });

  it('an account already partially migrated (tao\'s exact CC-16 shape: some cards already in cardInstances, some still in cardInv) migrates only the leftovers without touching the rest', async () => {
    // Simulates cards created *after* the app-code cutover (already written straight to
    // cardInstances by cards.ts's normal grant path) coexisting with pre-cutover cards still
    // stuck in the embedded field — exactly the state found on the reporting account.
    await cardInstances.insertOne({ _id: 'newCard', accountId: 'acc1', defId: 'max', level: 3, gear: {}, locked: false });
    await seedAccount('acc1', { oldCard: card('oldCard', 'suyuan') });

    const r = await migrateOneAccount(saves, cardInstances, 'acc1', false);

    expect(r).toEqual({ ok: true, count: 1 }); // only the one leftover cardInv entry
    const docs = await cardInstances.find({ accountId: 'acc1' }).toArray();
    expect(docs.map((d) => d._id).sort()).toEqual(['newCard', 'oldCard']);
    // the pre-existing doc must be untouched, not overwritten by the migration's replaceOne
    expect(docs.find((d) => d._id === 'newCard')!.defId).toBe('max');
  });

  it('retries through a concurrent rev bump instead of losing a card gained mid-migration', async () => {
    await seedAccount('acc1', { c1: card('c1') });
    let attempts = 0;
    // Wraps the real collection: on the FIRST findOneAndUpdate attempt, simulates a concurrent
    // gameplay write (a new card granted + rev bumped) landing between migrateOneAccount's initial
    // read and its $unset — the real findOneAndUpdate call then naturally fails to match the now-
    // stale `rev` filter, forcing the documented retry path (see migrateOneAccount's doc comment).
    const racySaves = {
      findOne: saves.findOne.bind(saves),
      findOneAndUpdate: async (filter: Document, update: Document) => {
        attempts++;
        if (attempts === 1) {
          await saves.updateOne({ _id: 'acc1' }, { $set: { 'save.cardInv.c2': card('c2'), rev: 99 } });
        }
        return saves.findOneAndUpdate(filter, update);
      },
    } as unknown as Collection<Document>;

    const r = await migrateOneAccount(racySaves, cardInstances, 'acc1', false);

    expect(attempts).toBe(2);
    expect(r).toEqual({ ok: true, count: 2 }); // both c1 (original) and c2 (gained mid-migration) survive
    const docs = await cardInstances.find({ accountId: 'acc1' }).toArray();
    expect(docs.map((d) => d._id).sort()).toEqual(['c1', 'c2']);
    const saveDoc = await saves.findOne({ _id: 'acc1' });
    expect(saveDoc!.save.cardInv).toBeUndefined();
    expect(saveDoc!.rev).toBe(100); // bumped to 99 by the simulated race, then +1 on the successful unset
  });

  it('gives up after REV_RETRIES exhausted (persistent conflict) without silently losing data', async () => {
    await seedAccount('acc1', { c1: card('c1') });
    const alwaysRacySaves = {
      findOne: saves.findOne.bind(saves),
      // Every attempt loses the race — filter never matches, migrateOneAccount must eventually give up.
      findOneAndUpdate: async () => null,
    } as unknown as Collection<Document>;

    const r = await migrateOneAccount(alwaysRacySaves, cardInstances, 'acc1', false);

    expect(r).toEqual({ ok: false, error: 'rev conflict, retries exhausted' });
    // The idempotent bulkWrite upsert already ran on every attempt, so the card is safely in
    // cardInstances even though the account is left in the (still-resumable) unmigrated state.
    expect(await cardInstances.countDocuments({ accountId: 'acc1' })).toBe(1);
    const saveDoc = await saves.findOne({ _id: 'acc1' });
    expect(saveDoc!.save.cardInv).toBeDefined(); // never unset — a future re-run will pick this account back up
  });
});
