// db/client.ts + db/combatDocs.ts branch-coverage gaps (2026-08-15):
//   • createWorldMongo's connection-failure catch (logs a redacted URI, then rethrows) — never
//     exercised anywhere; every other test connects to a working shared mongod.
//   • ensureCombatIndexes' two best-effort try/catch index builds (marches / stationed
//     {worldId,ownerId,teamId} partial-unique indexes) — the catch (console.warn, does not throw)
//     only fires when pre-existing data already violates the uniqueness constraint at build time.
// Real Mongo (same shared rs0 mongod as the other e2e suites); the connection-failure case needs no
// working Mongo at all.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createWorldMongo, type WorldMongo } from '../src/db';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_db_gaps_test';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.db-gaps] Mongo unreachable (${URI}) — skipping duplicate-index cases.`);

describe('createWorldMongo — connection failure', () => {
  it('a bad/unreachable URI rejects (after logging a redacted connection-failure message)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        createWorldMongo('mongodb://user:secret@127.0.0.1:1/?replicaSet=rs0', 'nope', { serverSelectionTimeoutMS: 300 }),
      ).rejects.toThrow();
      expect(errSpy).toHaveBeenCalled();
      const [msg] = errSpy.mock.calls[0]!;
      // The URI in the logged message must be redacted (no plaintext credentials leaked to logs).
      expect(String(msg)).not.toContain('secret');
      expect(String(msg)).toContain('<redacted>');
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe.skipIf(!mongo)('ensureCombatIndexes — best-effort duplicate-data index build', () => {
  const m = mongo!;

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('pre-existing duplicate {worldId,ownerId,teamId} marches: index build fails, is caught + warned, ensureIndexes still resolves', async () => {
    await m.collections.marches.deleteMany({});
    // Bypass the app-level TEAM_BUSY guard by inserting two 'marching' docs for the same team directly —
    // exactly the "duplicate from before this index existed" scenario the try/catch defends against.
    await m.collections.marches.insertMany([
      { _id: 'm1', worldId: 'wdup', ownerId: 'acc1', teamId: 't1', fromTile: 'wdup:0:0', toTile: 'wdup:1:1', kind: 'move', troops: 1, departAt: 0, arriveAt: 1, status: 'marching', rev: 0 },
      { _id: 'm2', worldId: 'wdup', ownerId: 'acc1', teamId: 't1', fromTile: 'wdup:0:0', toTile: 'wdup:2:2', kind: 'move', troops: 1, departAt: 0, arriveAt: 1, status: 'marching', rev: 0 },
    ] as never);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(m.ensureIndexes()).resolves.toBeUndefined();
      const warned = warnSpy.mock.calls.some(([msg]) => String(msg).includes('marches team-unique index not built'));
      expect(warned).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('pre-existing duplicate {worldId,ownerId,teamId} stationed docs: index build fails, is caught + warned, ensureIndexes still resolves', async () => {
    await m.collections.stationed.deleteMany({});
    // The previous test's ensureIndexes() call already built stationed's unique index (stationed was
    // empty at that point) — drop it first so these two duplicate inserts aren't rejected up front,
    // isolating the case under test: build-time (not insert-time) constraint violation.
    await m.collections.stationed.dropIndexes().catch(() => {});
    await m.collections.stationed.insertMany([
      { _id: 'wdup:0:0', worldId: 'wdup', ownerId: 'acc1', teamId: 't1', tile: 'wdup:0:0', x: 0, y: 0, army: [], troops: 1, sinceAt: 0 },
      { _id: 'wdup:1:1', worldId: 'wdup', ownerId: 'acc1', teamId: 't1', tile: 'wdup:1:1', x: 1, y: 1, army: [], troops: 1, sinceAt: 0 },
    ] as never);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(m.ensureIndexes()).resolves.toBeUndefined();
      const warned = warnSpy.mock.calls.some(([msg]) => String(msg).includes('stationed team-unique index not built'));
      expect(warned).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
