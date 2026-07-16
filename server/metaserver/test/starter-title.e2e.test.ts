// Starter-title grant e2e (TITLE_DESIGN §6): every account owns the newbie title.
// Covers new accounts (seeded by makeNewSave) and the lazy backfill on GET /save for pre-existing
// accounts created before the starter grant was wired — including that the backfill never steals the
// equipped slot from a title the player actually earned.
// Requires `cd server && docker compose up -d` + `tsc -b` first (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, makeNewSave, ladderTitleId, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_starter_title_test';
const jwt: JwtConfig = { secret: 'test-secret' };
const KEY = 'k';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
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
});
