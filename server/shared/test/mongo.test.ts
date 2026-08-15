// Tests for src/mongo/* (createMongo + each domain's ensureXIndexes) against a real mongod
// (spun up by test/globalSetup.ts via mongodb-memory-server — see there). Unlike the
// Redis-optional modules (dailyCounter/rateLimiter), there is no "unreachable, skip" fallback
// here: globalSetup guarantees a Mongo is available for every test run.
import { describe, it, expect, afterAll, vi } from 'vitest';
import { MongoClient } from 'mongodb';
import { createMongo } from '../src/mongo/client';
import { isAnonymousAccount, type AccountDoc } from '../src/mongo/accountDocs';

function uniqueDbName(): string {
  return `nw_shared_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

describe('createMongo', () => {
  const handles: { close(): Promise<void> }[] = [];
  afterAll(async () => {
    await Promise.all(handles.map((h) => h.close()));
  });

  it('connects, wires up every collection, and ensureIndexes() builds indexes across all domains', async () => {
    const uri = process.env.NW_MONGO_URI!;
    const handle = await createMongo(uri, uniqueDbName());
    handles.push(handle);

    // Every Collections property is wired to a real Collection handle.
    expect(handle.client).toBeInstanceOf(MongoClient);
    expect(handle.db.databaseName).toBeTruthy();
    expect(handle.collections.saves.collectionName).toBe('saves');
    expect(handle.collections.accounts.collectionName).toBe('accounts');
    expect(handle.collections.ladderSeasonSnapshots.collectionName).toBe('ladderSeasonSnapshots');

    await handle.ensureIndexes();

    // Spot-check one index from each domain file actually landed (name/key, not exhaustive).
    const accountIdx = await handle.collections.accounts.indexes();
    expect(accountIdx.some((i) => i.key && 'openid' in i.key)).toBe(true);
    expect(accountIdx.some((i) => i.key && 'publicId' in i.key)).toBe(true);

    const savesIdx = await handle.collections.saves.indexes();
    expect(savesIdx.some((i) => i.name === 'pvp_season_elo')).toBe(true);

    const matchIdx = await handle.collections.matches.indexes();
    expect(matchIdx.some((i) => i.key && i.key.roomId === 1 && i.unique)).toBe(true);
    expect(matchIdx.some((i) => i.key && 'expireAt' in i.key && i.expireAfterSeconds === 0)).toBe(true);

    const replayBlobIdx = await handle.collections.replayBlobs.indexes();
    expect(replayBlobIdx.some((i) => 'expireAt' in i.key)).toBe(true);

    const pveVerIdx = await handle.collections.pveVerifications.indexes();
    expect(pveVerIdx.some((i) => i.key && i.key.accountId === 1 && i.key.ts === -1)).toBe(true);

    const appealsIdx = await handle.collections.appeals.indexes();
    expect(appealsIdx.some((i) => i.unique && i.partialFilterExpression)).toBe(true);

    const feedbackIdx = await handle.collections.feedback.indexes();
    expect(feedbackIdx.some((i) => i.key && i.key.createdAt === -1)).toBe(true);

    const mailIdx = await handle.collections.mail.indexes();
    expect(mailIdx.some((i) => i.key && i.key.to === 1)).toBe(true);
    expect(mailIdx.some((i) => 'expireAt' in i.key && i.expireAfterSeconds === 0)).toBe(true);

    const cardIdemIdx = await handle.collections.cardIdem.indexes();
    expect(cardIdemIdx.some((i) => 'expireAt' in i.key && i.expireAfterSeconds === 0)).toBe(true);

    const equipInstIdx = await handle.collections.equipmentInstances.indexes();
    expect(equipInstIdx.some((i) => i.key && i.key.accountId === 1)).toBe(true);

    const cardInstIdx = await handle.collections.cardInstances.indexes();
    expect(cardInstIdx.some((i) => i.unique && i.sparse && 'gearInstanceIds' in i.key)).toBe(true);

    const materialInstIdx = await handle.collections.materialInstances.indexes();
    expect(materialInstIdx.some((i) => i.key && i.key.accountId === 1 && i.key.materialId === 1)).toBe(true);

    const balanceIdx = await handle.collections.pvpCardStats.indexes();
    expect(balanceIdx.some((i) => i.key && i.key.cardId === 1 && i.key.day === 1)).toBe(true);

    const adsIdx = await handle.collections.adsTokens.indexes();
    expect(adsIdx.some((i) => 'expireAt' in i.key && i.expireAfterSeconds === 0)).toBe(true);

    const eventsIdx = await handle.collections.events.indexes();
    expect(eventsIdx.some((i) => i.key && i.key.windowStart === 1 && i.key.windowEnd === 1)).toBe(true);

    const eventParticipantsIdx = await handle.collections.eventParticipants.indexes();
    expect(eventParticipantsIdx.some((i) => i.key && i.key.accountId === 1 && i.key.eventId === 1)).toBe(true);

    const ladderSnapIdx = await handle.collections.ladderSeasonSnapshots.indexes();
    expect(ladderSnapIdx.some((i) => i.key && i.key.seasonNo === 1 && !('accountId' in i.key))).toBe(true);
    expect(ladderSnapIdx.some((i) => i.key && i.key.accountId === 1 && i.key.seasonNo === -1)).toBe(true);
  });

  it('ensureIndexes() is idempotent (calling twice does not throw / does not duplicate)', async () => {
    const uri = process.env.NW_MONGO_URI!;
    const handle = await createMongo(uri, uniqueDbName());
    handles.push(handle);
    await handle.ensureIndexes();
    await handle.ensureIndexes();
    const idx = await handle.collections.accounts.indexes();
    // _id_ + the 6 explicit indexes on accounts (openid/deviceId/password.loginId/oauth/publicId/
    // reputationDecayAt), not doubled by a second ensureIndexes() call.
    expect(idx.length).toBe(7);
  });

  it('rejects and logs a credential-free error message when the connection fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        createMongo('mongodb://baduser:badpass@127.0.0.1:1/?serverSelectionTimeoutMS=200', 'whatever', {
          serverSelectionTimeoutMS: 200,
        }),
      ).rejects.toThrow();

      expect(errSpy).toHaveBeenCalledTimes(1);
      const logged = errSpy.mock.calls[0]![0] as string;
      expect(logged).toContain('[mongo] Failed to connect to MongoDB');
      expect(logged).toContain('db=whatever');
      // Credentials must never be logged (sanitizeMongoUri strips user:pass@).
      expect(logged).not.toContain('baduser');
      expect(logged).not.toContain('badpass');
      expect(logged).toContain('<redacted>@');
    } finally {
      errSpy.mockRestore();
    }
  }, 15000);
});

describe('isAnonymousAccount', () => {
  const base: AccountDoc = { _id: 'acc-1', createdAt: 0 };

  it('true when no openid/password/oauth is attached', () => {
    expect(isAnonymousAccount(base)).toBe(true);
  });

  it('false when openid is present', () => {
    expect(isAnonymousAccount({ ...base, openid: 'wx-1' })).toBe(false);
  });

  it('false when password credentials are present', () => {
    expect(isAnonymousAccount({ ...base, password: { loginId: 'a@b.com', hash: 'x' } })).toBe(false);
  });

  it('false when oauth has at least one entry', () => {
    expect(isAnonymousAccount({ ...base, oauth: [{ provider: 'google', sub: 's1' }] })).toBe(false);
  });

  it('true when oauth is an empty array (no real credential)', () => {
    expect(isAnonymousAccount({ ...base, oauth: [] })).toBe(true);
  });
});
