// L2-1: Season-close automatic settlement end-to-end unit test (no Mongo, in-memory fake cols, same style as internal.test.ts).
// Coverage:
//  - settleSeasonParticipants actively settles participants: sends reward mail for qualifying ranks + grants season title + writes snapshot;
//  - Repeated close of the same seasonId is idempotent: mail/title/snapshot are never sent twice (acceptance of "idempotency unit test");
//  - Snapshot peakElo/peakRank matches the season peak;
//  - rollSeason settles the previous season before advancing + CAS prevents concurrent double-advance.
import { describe, it, expect } from 'vitest';
import {
  makeNewSave,
  ladderTitleId,
  seasonPeakCoins,
  eloToRank,
  type Collections,
  type SaveData,
  type LadderSeasonDoc,
} from '@nw/shared';
import { settleSeasonParticipants, rollSeason } from '../src/ladderSeason.js';
import type { CommercialClient } from '../src/commercialClient.js';

// commercial is not actually called in the season settlement path (coins are delivered via mail attachment), so a stub suffices.
const commercial = { available: true } as unknown as CommercialClient;

// ── In-memory fake: supports dot-path query/write, $setOnInsert upsert, $addToSet, and CAS findOneAndUpdate ──

function getDotted(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}
function setDotted(obj: Record<string, unknown>, path: string, val: unknown): void {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]!] == null) o[keys[i]!] = {};
    o = o[keys[i]!] as Record<string, unknown>;
  }
  o[keys[keys.length - 1]!] = val;
}
function matches(doc: Record<string, unknown>, q: Record<string, unknown>): boolean {
  return Object.entries(q).every(([k, v]) => getDotted(doc, k) === v);
}

class FakeCol {
  docs = new Map<string, Record<string, unknown>>();
  async findOne(q: Record<string, unknown>) {
    if (typeof q._id === 'string' && Object.keys(q).length === 1) return this.docs.get(q._id) ?? null;
    for (const d of this.docs.values()) if (matches(d, q)) return d;
    return null;
  }
  find(q: Record<string, unknown> = {}) {
    const arr = [...this.docs.values()].filter((d) => matches(d, q));
    return {
      async *[Symbol.asyncIterator]() {
        for (const d of arr) yield d;
      },
      toArray: async () => arr,
    };
  }
  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, Record<string, unknown>>,
    opts?: { upsert?: boolean },
  ) {
    let d =
      typeof filter._id === 'string'
        ? this.docs.get(filter._id)
        : [...this.docs.values()].find((x) => matches(x, filter));
    const existed = !!d;
    if (!d) {
      if (!opts?.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      d = { _id: filter._id };
      this.docs.set(filter._id as string, d);
    }
    if (update.$setOnInsert && !existed) Object.assign(d, update.$setOnInsert);
    if (update.$set) for (const [k, v] of Object.entries(update.$set)) setDotted(d, k, v);
    if (update.$addToSet)
      for (const [k, v] of Object.entries(update.$addToSet)) {
        const cur = (getDotted(d, k) as unknown[]) ?? [];
        if (!cur.includes(v)) cur.push(v);
        setDotted(d, k, cur);
      }
    return { matchedCount: existed ? 1 : 0, modifiedCount: 1, upsertedCount: existed ? 0 : 1 };
  }
  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, Record<string, unknown>>,
    opts?: { returnDocument?: 'before' | 'after' },
  ) {
    const d =
      typeof filter._id === 'string'
        ? this.docs.get(filter._id)
        : [...this.docs.values()].find((x) => matches(x, filter));
    if (!d || !matches(d, filter)) return null;
    const before = { ...d };
    if (update.$set) for (const [k, v] of Object.entries(update.$set)) setDotted(d, k, v);
    return opts?.returnDocument === 'before' ? before : d;
  }
  async replaceOne(_filter: Record<string, unknown>, doc: Record<string, unknown>) {
    this.docs.set(doc._id as string, { ...doc });
    return { matchedCount: 1 };
  }
  async countDocuments(q: Record<string, unknown> = {}) {
    return [...this.docs.values()].filter((d) => matches(d, q)).length;
  }
}

interface Fake {
  cols: Collections;
  saves: FakeCol;
  mail: FakeCol;
  ladderSeasons: FakeCol;
  snaps: FakeCol;
}

/** seed: accountId → peak elo (determines rank/reward). All players have pvp.seasonNo=1. */
function makeFake(seed: Record<string, number>): Fake {
  const saves = new FakeCol();
  const mail = new FakeCol();
  const ladderSeasons = new FakeCol();
  const snaps = new FakeCol();
  for (const [id, peakElo] of Object.entries(seed)) {
    const s: SaveData = makeNewSave(id, 1000);
    s.pvp.seasonPeakElo = peakElo;
    s.pvp.seasonPeakRank = eloToRank(peakElo);
    saves.docs.set(id, { _id: id, save: s, rev: s.rev });
  }
  const cols = { saves, mail, ladderSeasons, ladderSeasonSnapshots: snaps } as unknown as Collections;
  return { cols, saves, mail, ladderSeasons, snaps };
}

function titlesOf(f: Fake, id: string): string[] {
  return ((f.saves.docs.get(id)!.save as SaveData).titles ?? []) as string[];
}

describe('settleSeasonParticipants (L2-1 end-of-season close loop)', () => {
  it('settle participants: qualifying rank receives reward mail + season title granted + snapshot written', async () => {
    const f = makeFake({ alice: 1900 /* master */, bob: 1000 /* bronze */ });
    const res = await settleSeasonParticipants(f.cols, commercial, 1, 100);

    expect(res).toEqual({ settled: 2, rewarded: 1 }); // only master tier earns coins

    // Title: both players receive the season title for their respective rank (idempotent $addToSet)
    expect(titlesOf(f, 'alice')).toContain(ladderTitleId(1, 'master'));
    expect(titlesOf(f, 'bob')).toContain(ladderTitleId(1, 'bronze'));

    // Mail: only master receives mail (bronze has 0 coins, so no mail is sent)
    expect(await f.mail.countDocuments()).toBe(1);
    const mailDoc = (await f.mail.find().toArray())[0] as Record<string, unknown>;
    expect(mailDoc._id).toBe('ladder.season.1.alice:alice');

    // Snapshot: one entry per player; peakElo/peakRank match the season peak
    expect(await f.snaps.countDocuments()).toBe(2);
    const aliceSnap = f.snaps.docs.get('1:alice')!;
    expect(aliceSnap).toMatchObject({
      seasonNo: 1,
      accountId: 'alice',
      peakElo: 1900,
      peakRank: 'master',
      coins: seasonPeakCoins('master'),
      titleId: ladderTitleId(1, 'master'),
    });
    const bobSnap = f.snaps.docs.get('1:bob')!;
    expect(bobSnap).toMatchObject({ peakElo: 1000, peakRank: 'bronze', coins: 0 });
  });

  it('repeated close of same seasonId is idempotent: mail/title/snapshot are never sent twice', async () => {
    const f = makeFake({ alice: 1900 });
    await settleSeasonParticipants(f.cols, commercial, 1, 100);
    await settleSeasonParticipants(f.cols, commercial, 1, 200); // run the same season again

    expect(await f.mail.countDocuments()).toBe(1); // mail deduplicated by dispatchKey
    expect(titlesOf(f, 'alice')).toEqual([ladderTitleId(1, 'master')]); // no duplicate title
    expect(await f.snaps.countDocuments()).toBe(1); // snapshot deduplicated by composite _id
    expect(f.snaps.docs.get('1:alice')!.ts).toBe(100); // $setOnInsert does not overwrite the first settlement
  });
});

describe('rollSeason (L2-1 close and open a new season)', () => {
  it('settles all participants of the previous season before advancing, then advances the clock to the next season', async () => {
    const f = makeFake({ alice: 1900 });
    f.ladderSeasons.docs.set('current', {
      _id: 'current',
      seasonNo: 1,
      startAt: 0,
      endAt: 1000,
      state: 'active',
    } satisfies LadderSeasonDoc as unknown as Record<string, unknown>);

    const next = await rollSeason(f.cols, commercial, 5000);

    expect(next.seasonNo).toBe(2);
    expect(next.state).toBe('active');
    // previous season (1) has been settled
    expect(titlesOf(f, 'alice')).toContain(ladderTitleId(1, 'master'));
    expect(await f.mail.countDocuments()).toBe(1);
    expect(await f.snaps.countDocuments()).toBe(1);
  });

  it('CAS prevents concurrent double-advance: does not re-advance when state is not active', async () => {
    const f = makeFake({ alice: 1900 });
    f.ladderSeasons.docs.set('current', {
      _id: 'current',
      seasonNo: 3,
      startAt: 0,
      endAt: 1000,
      state: 'settling', // already mid-settlement
    } satisfies LadderSeasonDoc as unknown as Record<string, unknown>);

    const r = await rollSeason(f.cols, commercial, 5000);
    expect(r.seasonNo).toBe(3); // returned as-is, not advanced
    expect(await f.snaps.countDocuments()).toBe(0); // not settled
  });
});
