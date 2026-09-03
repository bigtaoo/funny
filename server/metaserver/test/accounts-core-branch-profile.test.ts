// Branch-coverage backfill for src/accounts/profile.ts (2026-09-03 branch-coverage task, group F):
// the lazy-backfill loops behind displayName / publicId, plus getProfile's conditional response fields.
//
// Why this file exists: every caller (GET /save, match reports, socialsvc room player lists) reaches
// these through '../dist/app.js' in the existing e2e suites, which v8 coverage cannot attribute back to
// src. And the branches that were left untaken are precisely the check-then-write windows: both
// ensureDisplayName and ensurePublicId read, then conditionally write, then re-read — a shape whose
// whole purpose is to survive a concurrent writer, which no HTTP-level test can produce. The
// RacingAccounts double below lands that concurrent write inside the window.
//
// What these branches decide for the player: whether they end up with a nickname/publicId at all
// (a null there shows up as a raw accountId in every room list and match record), and whether a
// publicId collision retries or 500s their very first login.
import { describe, expect, it } from 'vitest';
import { makeNewSave, type Collections, type SaveData } from '@nw/shared';
import {
  ensureDisplayName,
  ensurePublicId,
  getDisplayName,
  getProfile,
  getRegion,
  hasFreeRename,
  setDisplayName,
} from '../src/accounts/profile.js';
import { FakeCollection } from './helpers/fakeCollection.js';

const TS = 1_700_000_000_000;

interface AccountDoc {
  _id: string;
  displayName?: string;
  publicId?: string;
  nameChosen?: boolean;
  region?: string;
  flags?: { mutedUntil?: number };
}
type SaveDoc = { _id: string; save: SaveData; rev: number };

/**
 * Lets a test (a) hide a field from the Nth read and (b) land a "concurrent" write in the window
 * between that read and profile.ts's conditional update, and separately hijack the first updateOne.
 */
class RacingAccounts extends FakeCollection<AccountDoc> {
  reads = 0;
  writes = 0;
  onRead?: (n: number, doc: AccountDoc | null) => AccountDoc | null;
  /** Return a result to answer the Nth updateOne with, or undefined to fall through to the real one. */
  onWrite?: (n: number) => { matchedCount: number; modifiedCount: number; upsertedCount: number } | undefined;

  override async findOne(q: Record<string, unknown> = {}, o?: unknown): Promise<AccountDoc | null> {
    const d = await super.findOne(q, o);
    this.reads++;
    return this.onRead ? this.onRead(this.reads, d) : d;
  }

  override async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, Record<string, unknown>>,
    opts?: { upsert?: boolean },
  ) {
    this.writes++;
    const forced = this.onWrite?.(this.writes);
    if (forced) return forced;
    return super.updateOne(filter, update, opts);
  }
}

function colsFor(accounts: FakeCollection<AccountDoc>, saves?: FakeCollection<SaveDoc>): Collections {
  return { accounts, saves: saves ?? new FakeCollection<SaveDoc>() } as unknown as Collections;
}

// ── getRegion / hasFreeRename / setDisplayName ──────────────────────────────────────────────────
describe('getRegion', () => {
  it('stored region is returned; a pre-feature account with no region field defaults to "global"', async () => {
    const accounts = new FakeCollection<AccountDoc>().seed({ _id: 'a', region: 'cn' }, { _id: 'b' });
    expect(await getRegion(colsFor(accounts), 'a')).toBe('cn');
    expect(await getRegion(colsFor(accounts), 'b')).toBe('global');
    expect(await getRegion(colsFor(accounts), 'ghost')).toBe('global');
  });
});

describe('hasFreeRename', () => {
  it('true until the player deliberately chooses a name, false afterwards', async () => {
    const accounts = new FakeCollection<AccountDoc>().seed(
      { _id: 'never', displayName: 'AutoName' },
      { _id: 'chosen', displayName: 'Wei', nameChosen: true },
    );
    expect(await hasFreeRename(colsFor(accounts), 'never')).toBe(true);
    expect(await hasFreeRename(colsFor(accounts), 'chosen')).toBe(false);
    // A missing row must not read as "already used" — that would silently eat the free rename.
    expect(await hasFreeRename(colsFor(accounts), 'ghost')).toBe(true);
  });
});

describe('setDisplayName', () => {
  it('writes the name and marks it as deliberately chosen (so the next rename is paid)', async () => {
    const accounts = new FakeCollection<AccountDoc>().seed({ _id: 'a', displayName: 'AutoName' });
    await setDisplayName(colsFor(accounts), 'a', 'Wei');
    expect(accounts.docs.get('a')).toMatchObject({ displayName: 'Wei', nameChosen: true });
    expect(await hasFreeRename(colsFor(accounts), 'a')).toBe(false);
  });
});

// ── ensureDisplayName ───────────────────────────────────────────────────────────────────────────
describe('ensureDisplayName (lazy backfill)', () => {
  it('an existing name is returned without any write', async () => {
    const accounts = new RacingAccounts();
    accounts.seed({ _id: 'a', displayName: 'Wei' });
    expect(await ensureDisplayName(colsFor(accounts), 'a')).toBe('Wei');
    expect(accounts.writes).toBe(0);
  });

  it('no name yet -> a random default is generated and persisted', async () => {
    const accounts = new RacingAccounts();
    accounts.seed({ _id: 'a' });
    const name = await ensureDisplayName(colsFor(accounts), 'a');
    expect(name).toBeTruthy();
    expect(accounts.docs.get('a')!.displayName).toBe(name);
    // getDisplayName is the read-only alias over the same backfill.
    expect(await getDisplayName(colsFor(accounts), 'a')).toBe(name);
  });

  it('a concurrent writer named the account inside the window -> that name wins, ours is discarded', async () => {
    // Both callers generated a candidate; the guarded update ($exists:false) matches for exactly one of
    // them. The loser must re-read and adopt the winner's name — two different nicknames for the same
    // account across two concurrent requests would be visible to the player as a flickering name.
    const accounts = new RacingAccounts();
    accounts.seed({ _id: 'a' });
    accounts.onRead = (n) => {
      if (n === 1) {
        accounts.docs.get('a')!.displayName = 'RivalName';
        return { _id: 'a' }; // our read predates the rival's write
      }
      return accounts.docs.get('a') ?? null;
    };
    expect(await ensureDisplayName(colsFor(accounts), 'a')).toBe('RivalName');
  });

  it('the account row disappears inside the window -> the generated candidate is still returned', async () => {
    // Never null: callers embed this straight into a response/room list, and a missing nickname there
    // renders as a raw accountId.
    const accounts = new RacingAccounts();
    accounts.seed({ _id: 'a' });
    accounts.onRead = (n) => {
      if (n === 1) { accounts.docs.delete('a'); return { _id: 'a' }; }
      return null;
    };
    const name = await ensureDisplayName(colsFor(accounts), 'a');
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });
});

// ── ensurePublicId ──────────────────────────────────────────────────────────────────────────────
describe('ensurePublicId (lazy allocation, 9 digits, unique index)', () => {
  it('an existing publicId is returned without any write', async () => {
    const accounts = new RacingAccounts();
    accounts.seed({ _id: 'a', publicId: '123456789' });
    expect(await ensurePublicId(colsFor(accounts), 'a')).toBe('123456789');
    expect(accounts.writes).toBe(0);
  });

  it('first allocation writes exactly 9 digits with a non-zero leading digit', async () => {
    const accounts = new RacingAccounts();
    accounts.seed({ _id: 'a' });
    const id = await ensurePublicId(colsFor(accounts), 'a');
    expect(id).toMatch(/^[1-9]\d{8}$/);
    expect(accounts.docs.get('a')!.publicId).toBe(id);
  });

  it('a concurrent writer allocated one inside the window -> that id is adopted (never reassigned)', async () => {
    const accounts = new RacingAccounts();
    accounts.seed({ _id: 'a' });
    accounts.onRead = (n) => {
      if (n === 1) { accounts.docs.get('a')!.publicId = '900000001'; return { _id: 'a' }; }
      return accounts.docs.get('a') ?? null;
    };
    expect(await ensurePublicId(colsFor(accounts), 'a')).toBe('900000001');
    expect(accounts.docs.get('a')!.publicId).toBe('900000001');
  });

  it('guarded update matched nothing AND the re-read still shows none -> a second attempt allocates', async () => {
    // The genuinely ambiguous outcome (write lost, nobody else set it either): the loop must go round
    // again rather than returning undefined or throwing on the first hiccup.
    const accounts = new RacingAccounts();
    accounts.seed({ _id: 'a' });
    accounts.onWrite = (n) => (n === 1 ? { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 } : undefined);
    const id = await ensurePublicId(colsFor(accounts), 'a');
    expect(id).toMatch(/^[1-9]\d{8}$/);
    expect(accounts.docs.get('a')!.publicId).toBe(id);
    expect(accounts.writes).toBe(2);
  });

  it('a unique-index collision on the candidate -> retried with a fresh candidate', async () => {
    // 900M-wide space, so this is astronomically rare in practice — but it is a real 11000 from Mongo
    // and it must not surface as a failed login.
    const accounts = new RacingAccounts();
    accounts.seed({ _id: 'a' });
    let first = true;
    accounts.onWrite = () => {
      if (first) { first = false; throw Object.assign(new Error('duplicate key'), { code: 11000 }); }
      return undefined;
    };
    const id = await ensurePublicId(colsFor(accounts), 'a');
    expect(id).toMatch(/^[1-9]\d{8}$/);
    expect(accounts.docs.get('a')!.publicId).toBe(id);
  });

  it('eight consecutive collisions -> throws rather than returning a bogus id', async () => {
    const accounts = new RacingAccounts();
    accounts.seed({ _id: 'a' });
    accounts.onWrite = () => { throw Object.assign(new Error('duplicate key'), { code: 11000 }); };
    await expect(ensurePublicId(colsFor(accounts), 'a')).rejects.toThrow('failed to allocate publicId after retries');
    expect(accounts.writes).toBe(8);
    expect(accounts.docs.get('a')!.publicId).toBeUndefined();
  });
});

// ── getProfile ──────────────────────────────────────────────────────────────────────────────────
describe('getProfile (conditional response fields)', () => {
  it('fully equipped + muted account -> every optional field is present', async () => {
    const accounts = new FakeCollection<AccountDoc>().seed({
      _id: 'a', displayName: 'Wei', publicId: '123456789', flags: { mutedUntil: TS + 60_000 },
    });
    const save = makeNewSave('a', TS);
    save.equipped = { title: 'veteran', avatar: 'preset:3', 'skin:archer': 'ink_a', 'skin:mage': 'ink_b' };
    const saves = new FakeCollection<SaveDoc>().seed({ _id: 'a', save, rev: save.rev });

    expect(await getProfile(colsFor(accounts, saves), 'a')).toEqual({
      displayName: 'Wei',
      publicId: '123456789',
      equippedTitle: 'veteran',
      avatarId: 'preset:3',
      equippedSkins: ['ink_a', 'ink_b'],
      mutedUntil: TS + 60_000,
    });
  });

  it('equipped map with a title but no avatar and no skin slots -> avatarId and equippedSkins are omitted', async () => {
    // The empty-array guard matters: an `equippedSkins: []` in the payload would make the gateway's room
    // list treat the player as having explicitly cleared their skins rather than never having equipped one.
    const accounts = new FakeCollection<AccountDoc>().seed({ _id: 'a', displayName: 'Wei', publicId: '123456789' });
    const save = makeNewSave('a', TS);
    save.equipped = { title: 'veteran' };
    const saves = new FakeCollection<SaveDoc>().seed({ _id: 'a', save, rev: save.rev });

    expect(await getProfile(colsFor(accounts, saves), 'a')).toEqual({
      displayName: 'Wei', publicId: '123456789', equippedTitle: 'veteran',
    });
  });

  it('no save document and no mute -> only displayName/publicId, both lazily backfilled', async () => {
    const accounts = new FakeCollection<AccountDoc>().seed({ _id: 'a' });
    const profile = await getProfile(colsFor(accounts), 'a');
    expect(Object.keys(profile).sort()).toEqual(['displayName', 'publicId']);
    expect(profile.publicId).toMatch(/^[1-9]\d{8}$/);
    expect(profile.displayName).toBeTruthy();
  });

  it('a mute that has already elapsed is still reported verbatim (the caller compares it against now)', async () => {
    const accounts = new FakeCollection<AccountDoc>().seed({
      _id: 'a', displayName: 'Wei', publicId: '123456789', flags: { mutedUntil: TS - 1 },
    });
    expect((await getProfile(colsFor(accounts), 'a')).mutedUntil).toBe(TS - 1);
  });

  it('mutedUntil === 0 is omitted rather than sent as a falsy timestamp', async () => {
    const accounts = new FakeCollection<AccountDoc>().seed({
      _id: 'a', displayName: 'Wei', publicId: '123456789', flags: { mutedUntil: 0 },
    });
    expect((await getProfile(colsFor(accounts), 'a')).mutedUntil).toBeUndefined();
  });
});
