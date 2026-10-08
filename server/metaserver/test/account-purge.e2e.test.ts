// C5-b account purge orchestrator e2e (accountPurge.ts): real Mongo for the meta collections + a scripted fake
// for the five remote services (each service's own purge endpoint is covered in that service's test suite).
// Covers: grace-period cutoff, step order + resume after failure/pending, local meta erasure, tombstone shape,
// replay-archive scrub (mtime preserved), and idempotency.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOKEN_REVOCATION_RETENTION_MS, TOKEN_REVOCATIONS_PATH, createMongo, makeNewSave, type MongoHandle } from '@nw/shared';
import { buildApp } from '../src/app.js';
import { purgeDeletedAccountsOnce } from '../src/accountPurge.js';
import type { AccountPurgeClient, PurgeCallResult, RemotePurgeStep } from '../src/accountPurgeClient.js';
import { ACCOUNT_DELETE_GRACE_MS } from '../src/service/auth/helpers.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_account_purge_test';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[account-purge.e2e] Mongo unreachable (${URI}) — skipping.`);

const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const DAY = 24 * 3600 * 1000;

/** Records every call; per-step behavior is scriptable (default: done). */
class FakePurgeClient implements AccountPurgeClient {
  readonly calls: { step: RemotePurgeStep; accountId: string; body: Record<string, unknown> }[] = [];
  behavior: Partial<Record<RemotePurgeStep, 'done' | 'pending' | 'fail'>> = {};

  async purge(step: RemotePurgeStep, accountId: string, body: Record<string, unknown>): Promise<PurgeCallResult> {
    this.calls.push({ step, accountId, body });
    const b = this.behavior[step] ?? 'done';
    if (b === 'fail') return { ok: false, error: `${step}: 503 boom` };
    return { ok: true, done: b === 'done', data: { done: b === 'done', removed: {} } };
  }
  steps(accountId?: string): RemotePurgeStep[] {
    return this.calls.filter((c) => !accountId || c.accountId === accountId).map((c) => c.step);
  }
}

describe.skipIf(!mongo)('account purge orchestrator e2e', () => {
  const m = mongo!;
  let archiveDir: string;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    archiveDir = await mkdtemp(join(tmpdir(), 'nw-purge-archive-'));
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  let nextPublicId = 300_000_000;
  async function seedAccount(id: string, deletedAt?: number): Promise<void> {
    await m.collections.accounts.insertOne({
      _id: id,
      createdAt: 1,
      deviceId: `dev-${id}`,
      displayName: `Name ${id}`,
      publicId: id === 'gone' ? '111111111' : String(nextPublicId++),
      password: { loginId: `${id}@example.com`, hash: 'h' },
      flags: { gdprConsent: true },
      activeDays: [0, 1, 3], // retention-report activity (activityDays.ts) — must not survive the tombstone
      ...(deletedAt !== undefined ? { deletedAt, deletionConfirmToken: 'tok' } : {}),
    });
    const save = makeNewSave(id, 1);
    await m.collections.saves.insertOne({ _id: id, save, rev: save.rev });
  }

  const run = (client: AccountPurgeClient, now = NOW) =>
    purgeDeletedAccountsOnce({ cols: m.collections, client, now: () => now, archiveDir });

  it('only picks up accounts whose grace period has elapsed', async () => {
    await seedAccount('gone', NOW - ACCOUNT_DELETE_GRACE_MS - 1);
    await seedAccount('grace', NOW - ACCOUNT_DELETE_GRACE_MS + DAY); // still restorable
    await seedAccount('live');
    const client = new FakePurgeClient();

    const r = await run(client);
    expect(r).toEqual({ scanned: 1, purged: 1, pending: 0, failed: 0 });
    expect(new Set(client.calls.map((c) => c.accountId))).toEqual(new Set(['gone']));
    expect(await m.collections.saves.countDocuments({ _id: { $in: ['grace', 'live'] } })).toBe(2);
    expect((await m.collections.accounts.findOne({ _id: 'grace' }))?.deviceId).toBe('dev-grace');
  });

  it('calls the services in order, passes the device id to analytics, erases meta data, leaves a tombstone', async () => {
    const deletedAt = NOW - 8 * DAY;
    await seedAccount('gone', deletedAt);
    await seedAccount('other');
    const c = m.collections;
    await c.cardInstances.insertOne({ _id: 'card-1', accountId: 'gone' } as never);
    await c.cardInstances.insertOne({ _id: 'card-2', accountId: 'other' } as never);
    await c.equipmentInstances.insertOne({ _id: 'eq-1', accountId: 'gone' } as never);
    await c.feedback.insertOne({ accountId: 'gone', text: 'personal words' } as never);
    await c.pveStamina.insertOne({ _id: 'gone', current: 5, regenAt: 0 });
    await c.stateReplayShares.insertOne({ _id: 'share-1', createdBy: 'gone' } as never);
    await c.antiCheatReviews.insertOne({ _id: 'rev-1', accountId: 'gone' } as never);
    await c.matches.insertOne({
      roomId: 'room-1',
      players: [
        { side: 0, accountId: 'gone', displayName: 'Name gone', publicId: '111111111' },
        { side: 1, accountId: 'other', displayName: 'Name other', publicId: '222222222' },
      ],
    } as never);
    const client = new FakePurgeClient();

    const r = await run(client);
    expect(r.purged).toBe(1);
    expect(client.steps()).toEqual(['social', 'world', 'auction', 'commercial', 'analytics']);
    expect(client.calls.find((x) => x.step === 'analytics')!.body).toEqual({ deviceIds: ['dev-gone'] });
    expect(client.calls.find((x) => x.step === 'social')!.body).toEqual({ publicId: '111111111' });

    expect(await c.saves.countDocuments({ _id: 'gone' })).toBe(0);
    expect(await c.pveStamina.countDocuments({ _id: 'gone' })).toBe(0);
    expect(await c.cardInstances.distinct('_id')).toEqual(['card-2']);
    expect(await c.equipmentInstances.countDocuments({})).toBe(0);
    expect(await c.feedback.countDocuments({})).toBe(0);
    expect(await c.stateReplayShares.countDocuments({})).toBe(0);
    expect(await c.antiCheatReviews.countDocuments({})).toBe(0);
    const match = await c.matches.findOne({ roomId: 'room-1' });
    expect(match!.players[0]).toEqual({ side: 0, accountId: 'gone' });
    expect(match!.players[1]).toMatchObject({ displayName: 'Name other', publicId: '222222222' });

    // Tombstone: no credentials, no profile, no purge bookkeeping, no activeDays — just enough to keep answering 410.
    expect(await c.accounts.findOne({ _id: 'gone' })).toEqual({ _id: 'gone', createdAt: 1, deletedAt, purgedAt: NOW });
    // The freed unique credentials can be claimed by a new account.
    await c.accounts.insertOne({ _id: 'new', createdAt: NOW, deviceId: 'dev-gone', publicId: '111111111' });
  });

  it('stops at a failing step, backs off, and resumes at that step on a later tick', async () => {
    await seedAccount('gone', NOW - 8 * DAY);
    const client = new FakePurgeClient();
    client.behavior.auction = 'fail';

    const r1 = await run(client);
    expect(r1).toEqual({ scanned: 1, purged: 0, pending: 0, failed: 1 });
    expect(client.steps()).toEqual(['social', 'world', 'auction']);
    const mid = await m.collections.accounts.findOne({ _id: 'gone' });
    expect(Object.keys(mid!.purge!.steps!)).toEqual(['social', 'world']);
    expect(mid!.purge!.lastError).toContain('auction');
    expect(mid!.deviceId).toBe('dev-gone'); // nothing local touched yet
    expect(await m.collections.saves.countDocuments({ _id: 'gone' })).toBe(1);

    // Same tick time again: still inside the back-off, not re-claimed.
    const again = await run(client);
    expect(again.scanned).toBe(0);

    client.behavior.auction = 'done';
    client.calls.length = 0;
    const r2 = await run(client, NOW + 31 * 60 * 1000);
    expect(r2).toEqual({ scanned: 1, purged: 1, pending: 0, failed: 0 });
    expect(client.steps()).toEqual(['auction', 'commercial', 'analytics']); // social/world not repeated
    const done = await m.collections.accounts.findOne({ _id: 'gone' });
    expect(done!.purgedAt).toBe(NOW + 31 * 60 * 1000);
    expect(done!.purge).toBeUndefined();
  });

  it('a pending step (done:false) is retried without counting as failure', async () => {
    await seedAccount('gone', NOW - 8 * DAY);
    const client = new FakePurgeClient();
    client.behavior.auction = 'pending';
    const r = await run(client);
    expect(r).toEqual({ scanned: 1, purged: 0, pending: 1, failed: 0 });
    expect((await m.collections.accounts.findOne({ _id: 'gone' }))!.purge!.lastError).toBe('auction: pending');
  });

  it('is idempotent: a tombstoned account is never picked up again', async () => {
    await seedAccount('gone', NOW - 8 * DAY);
    const client = new FakePurgeClient();
    await run(client);
    client.calls.length = 0;
    const r = await run(client, NOW + 2 * DAY);
    expect(r.scanned).toBe(0);
    expect(client.calls).toHaveLength(0);
  });

  it('honors batchLimit', async () => {
    for (const id of ['a', 'b', 'c']) await seedAccount(id, NOW - 8 * DAY);
    const client = new FakePurgeClient();
    const r = await purgeDeletedAccountsOnce({ cols: m.collections, client, now: () => NOW, archiveDir, batchLimit: 2 });
    expect(r.purged).toBe(2);
    expect(await m.collections.accounts.countDocuments({ purgedAt: { $exists: true } })).toBe(2);
  });

  it('scrubs the replay cold archive and keeps the file mtime (365-day retention clock)', async () => {
    await seedAccount('gone', NOW - 8 * DAY);
    const metaPath = join(archiveDir, 'room-9.meta.json');
    const untouchedPath = join(archiveDir, 'room-10.meta.json');
    await writeFile(metaPath, JSON.stringify({
      roomId: 'room-9',
      players: [
        { side: 0, accountId: 'gone', displayName: 'Name gone', publicId: '111111111' },
        { side: 1, accountId: 'other', displayName: 'Name other', publicId: '222222222' },
      ],
    }));
    await writeFile(untouchedPath, JSON.stringify({ roomId: 'room-10', players: [{ side: 0, accountId: 'x', displayName: 'X' }] }));
    const old = new Date('2026-03-01T00:00:00Z');
    await utimes(metaPath, old, old);

    await run(new FakePurgeClient());

    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    expect(meta.players[0]).toEqual({ side: 0, accountId: 'gone' });
    expect(meta.players[1].displayName).toBe('Name other');
    expect((await stat(metaPath)).mtimeMs).toBe(old.getTime());
    expect(JSON.parse(await readFile(untouchedPath, 'utf8')).players[0].displayName).toBe('X');
  });

  it('does not tombstone when the archive scrub fails, and finishes on the next tick', async () => {
    await seedAccount('gone', NOW - 8 * DAY);
    const client = new FakePurgeClient();
    await rm(archiveDir, { recursive: true, force: true }); // readdir now throws
    const r1 = await run(client);
    expect(r1.failed).toBe(1);
    const mid = await m.collections.accounts.findOne({ _id: 'gone' });
    expect(mid!.purgedAt).toBeUndefined();
    expect(mid!.purge!.steps!.meta).toBeDefined();
    expect(mid!.purge!.lastError).toContain('replay archive');

    archiveDir = await mkdtemp(join(tmpdir(), 'nw-purge-archive-'));
    client.calls.length = 0;
    const r2 = await run(client, NOW + 31 * 60 * 1000);
    expect(r2.purged).toBe(1);
    expect(client.calls).toHaveLength(0); // every step was already confirmed
  });
  it('puts the account on the token revocation list at claim time, before any step — and keeps the first revokedAt', async () => {
    await seedAccount('gone', NOW - 8 * DAY);
    const client = new FakePurgeClient();
    client.behavior.social = 'fail'; // the very first step fails
    await run(client);
    const row = await m.collections.tokenRevocations.findOne({ _id: 'gone' });
    expect(row).toMatchObject({ revokedAt: NOW, reason: 'account_purged' });
    expect(row!.expireAt.getTime()).toBe(NOW + TOKEN_REVOCATION_RETENTION_MS);

    client.behavior = {};
    await run(client, NOW + 31 * 60 * 1000);
    expect((await m.collections.accounts.findOne({ _id: 'gone' }))!.purgedAt).toBeDefined();
    // The retry did not move revokedAt (tokens minted in between stay revoked, the TTL is not pushed out).
    expect((await m.collections.tokenRevocations.findOne({ _id: 'gone' }))!.revokedAt).toBe(NOW);
    // Accounts still inside the grace period are not revoked.
    await seedAccount('fresh', NOW - DAY);
    await run(client, NOW + 62 * 60 * 1000);
    expect(await m.collections.tokenRevocations.findOne({ _id: 'fresh' })).toBeNull();
  });

  it('serves the list on the internal route, filtered by since, behind the internal key', async () => {
    await m.collections.tokenRevocations.insertMany([
      { _id: 'old', revokedAt: NOW - 10 * DAY, reason: 'account_purged', expireAt: new Date(NOW + DAY) },
      { _id: 'new', revokedAt: NOW - DAY, reason: 'account_purged', expireAt: new Date(NOW + DAY) },
    ]);
    const app = await buildApp({ cols: m.collections, jwt: { secret: 's' }, internalKey: 'k', commercialUrl: null, gatewayUrl: null, now: () => NOW });
    try {
      const all = await app.inject({ method: 'GET', url: TOKEN_REVOCATIONS_PATH, headers: { 'x-internal-key': 'k' } });
      expect(all.statusCode).toBe(200);
      expect(all.json().asOf).toBe(NOW);
      expect(all.json().revocations.map((r: { accountId: string }) => r.accountId).sort()).toEqual(['new', 'old']);
      const since = await app.inject({ method: 'GET', url: `${TOKEN_REVOCATIONS_PATH}?since=${NOW - 2 * DAY}`, headers: { 'x-internal-key': 'k' } });
      expect(since.json().revocations).toEqual([{ accountId: 'new', revokedAt: NOW - DAY }]);
      const bad = await app.inject({ method: 'GET', url: `${TOKEN_REVOCATIONS_PATH}?since=abc`, headers: { 'x-internal-key': 'k' } });
      expect(bad.statusCode).toBe(400);
      const noKey = await app.inject({ method: 'GET', url: TOKEN_REVOCATIONS_PATH });
      expect(noKey.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
