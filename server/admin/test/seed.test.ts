// seedSuperAdmin() unit tests — previously only exercised via its "fresh empty DB + user/pass set" path
// (every e2e file's beforeEach calls it that way), leaving the no-seed-configured branch, the idempotent
// re-run branches (backfill seed flag / already flagged), and the concurrent-insert race unreachable.
// Fake collection implements only the four methods seed.ts actually calls — no real Mongo needed.
import { describe, expect, it, vi } from 'vitest';
import type { Collection } from 'mongodb';
import { seedSuperAdmin } from '../src/seed';
import type { AdminAccountDoc } from '../src/db';

function fakeCollection(docs: AdminAccountDoc[]): Collection<AdminAccountDoc> {
  return {
    estimatedDocumentCount: vi.fn(async () => docs.length),
    findOne: vi.fn(async ({ username }: { username: string }) => docs.find((d) => d.username === username) ?? null),
    updateOne: vi.fn(async ({ _id }: { _id: string }, patch: { $set: Partial<AdminAccountDoc> }) => {
      const doc = docs.find((d) => d._id === _id);
      if (doc) Object.assign(doc, patch.$set);
      return { acknowledged: true, matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0, upsertedCount: 0, upsertedId: null };
    }),
    insertOne: vi.fn(async (doc: AdminAccountDoc) => {
      docs.push(doc);
      return { acknowledged: true, insertedId: doc._id };
    }),
  } as unknown as Collection<AdminAccountDoc>;
}

const now = (): number => 1000;

describe('seedSuperAdmin', () => {
  it('no user/pass configured + zero accounts → warns, does not insert', async () => {
    const col = fakeCollection([]);
    await seedSuperAdmin({ adminAccounts: col } as never, null, null, now);
    expect(col.insertOne).not.toHaveBeenCalled();
  });

  it('no user/pass configured + accounts already exist → silently no-ops (no warning path taken)', async () => {
    const col = fakeCollection([{ _id: 'a1', username: 'existing', passwordHash: 'x', role: 'super', displayName: 'Existing', disabled: false, createdAt: 1 }]);
    await seedSuperAdmin({ adminAccounts: col } as never, null, null, now);
    expect(col.insertOne).not.toHaveBeenCalled();
  });

  it('fresh empty DB + user/pass set → inserts a new seed super admin', async () => {
    const col = fakeCollection([]);
    await seedSuperAdmin({ adminAccounts: col } as never, 'root', 'rootpass', now);
    expect(col.insertOne).toHaveBeenCalledTimes(1);
  });

  it('existing account missing the seed flag → backfills it (old DB migration path)', async () => {
    const docs: AdminAccountDoc[] = [{ _id: 'a1', username: 'root', passwordHash: 'x', role: 'super', displayName: 'Root', disabled: false, createdAt: 1 }];
    const col = fakeCollection(docs);
    await seedSuperAdmin({ adminAccounts: col } as never, 'root', 'rootpass', now);
    expect(col.updateOne).toHaveBeenCalledTimes(1);
    expect(col.insertOne).not.toHaveBeenCalled();
    expect(docs[0]!.seed).toBe(true);
  });

  it('existing account already seed:true → idempotent no-op, no write at all', async () => {
    const docs: AdminAccountDoc[] = [{ _id: 'a1', username: 'root', passwordHash: 'x', role: 'super', displayName: 'Root', disabled: false, createdAt: 1, seed: true }];
    const col = fakeCollection(docs);
    await seedSuperAdmin({ adminAccounts: col } as never, 'root', 'rootpass', now);
    expect(col.updateOne).not.toHaveBeenCalled();
    expect(col.insertOne).not.toHaveBeenCalled();
  });

  it('concurrent-startup unique-index conflict (code 11000) on insert is swallowed, not rethrown', async () => {
    const col = fakeCollection([]);
    (col.insertOne as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
    await expect(seedSuperAdmin({ adminAccounts: col } as never, 'root', 'rootpass', now)).resolves.toBeUndefined();
  });

  it('a non-duplicate-key insert error is rethrown', async () => {
    const col = fakeCollection([]);
    (col.insertOne as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('connection reset'));
    await expect(seedSuperAdmin({ adminAccounts: col } as never, 'root', 'rootpass', now)).rejects.toThrow('connection reset');
  });
});
