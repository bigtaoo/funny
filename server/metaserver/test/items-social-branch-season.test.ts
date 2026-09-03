// Branch-coverage backfill for src/ladderSeason.ts (group G, 2026-09-03).
// season-close.test.ts covers the settle/roll happy paths against well-formed saves; the branches left
// over are (a) the pvp-block fallbacks that a save written before seasonPeakRank/seasonPeakElo/seasonNo
// existed still hits, (b) the battle-pass backfill arm (no existing test gives a settling player a
// battlePass at all), (c) the two per-player failure catches that must not abort a whole season roll or
// block a returning player's migration, and (d) the cursor-buffer flush at SETTLE_PARTICIPANTS_BATCH_SIZE.
// Imports from '../src/...' (never '../dist/...') so v8 coverage attributes lines to source.
import { describe, it, expect } from 'vitest';
import {
  makeNewSave,
  makeFreshBattlePass,
  pendingBpRewards,
  seasonPeakCoins,
  eloToRank,
  ladderTitleId,
  SEASON_DURATION_MS,
  type Collections,
  type LadderSeasonDoc,
  type SaveData,
} from '@nw/shared';
import {
  getCurrentSeason,
  settleSeasonForPlayer,
  settleSeasonParticipants,
  migrateIfStale,
} from '../src/ladderSeason.js';
import type { CommercialClient } from '../src/commercialClient.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { FakeSocialsvc, ThrowingSocialsvc } from './helpers/fakeClients.js';
import type { FakeSaveDoc } from './helpers/fakeEquipCols.js';

// Coins are delivered as a mail attachment, never through commercial, so a stub suffices (same choice
// as season-close.test.ts).
const commercial = { available: true } as unknown as CommercialClient;

type FakeSeasonDoc = LadderSeasonDoc & Record<string, unknown>;
type FakeSnapDoc = { _id: string; seasonNo: number; accountId: string; coins: number; ts: number };

interface FakeSeasonCols {
  cols: Collections;
  saves: FakeCollection<FakeSaveDoc>;
  ladderSeasons: FakeCollection<FakeSeasonDoc>;
  snaps: FakeCollection<FakeSnapDoc>;
}

function makeCols(): FakeSeasonCols {
  const saves = new FakeCollection<FakeSaveDoc>();
  const ladderSeasons = new FakeCollection<FakeSeasonDoc>();
  const snaps = new FakeCollection<FakeSnapDoc>();
  return {
    cols: { saves, ladderSeasons, ladderSeasonSnapshots: snaps } as unknown as Collections,
    saves,
    ladderSeasons,
    snaps,
  };
}

function seedPlayer(f: FakeSeasonCols, id: string, mutate?: (s: SaveData) => void): SaveData {
  const s = makeNewSave(id, 1000);
  mutate?.(s);
  f.saves.seed({ _id: id, save: s, rev: s.rev });
  return s;
}

describe('getCurrentSeason', () => {
  it('read-back after the lazy upsert coming back empty -> returns the locally built season #1', async () => {
    // The upsert landed but the confirming read found nothing (read from a lagging secondary, or the
    // document dropped in between). Returning `fresh` keeps the caller working instead of throwing on
    // the season clock every entry point depends on.
    const f = makeCols();
    f.ladderSeasons.findOne = async () => null;
    const doc = await getCurrentSeason(f.cols, 5_000);
    expect(doc).toEqual({ _id: 'current', seasonNo: 1, startAt: 5_000, endAt: 5_000 + SEASON_DURATION_MS, state: 'active' });
  });
});

describe('settleSeasonForPlayer', () => {
  it('save with no seasonPeakRank/seasonPeakElo -> both derived from the live elo', async () => {
    const f = makeCols();
    const socialsvc = new FakeSocialsvc();
    const save = seedPlayer(f, 'p-nopeak', (s) => {
      s.pvp.elo = 1900;
      const pvp = s.pvp as Partial<SaveData['pvp']>;
      delete pvp.seasonPeakRank;
      delete pvp.seasonPeakElo;
    });
    const summary = await settleSeasonForPlayer(f.cols, commercial, socialsvc, 'p-nopeak', save, 4, 7_000);
    expect(summary.peakRank).toBe(eloToRank(1900));
    expect(summary.peakElo).toBe(1900);
    expect(summary.titleId).toBe(ladderTitleId(4, eloToRank(1900)));
    expect(summary.coins).toBe(seasonPeakCoins(eloToRank(1900)));
  });

  it('unclaimed battle-pass coin rewards are backfilled even when the rank reward itself is 0', async () => {
    // S6 lenient rule: earned-but-unclaimed BP rewards are not forfeited at season close. A bronze
    // player earns no rank coins, so any mail at all here comes purely from the BP backfill.
    const f = makeCols();
    const socialsvc = new FakeSocialsvc();
    const bp = { ...makeFreshBattlePass(4), level: 10 };
    const expectedBpCoins = pendingBpRewards(bp)
      .filter((r) => r.reward.kind === 'coins')
      .reduce((s, r) => s + r.reward.count, 0);
    expect(expectedBpCoins).toBeGreaterThan(0); // precondition: this fixture really has coins pending
    expect(seasonPeakCoins('bronze')).toBe(0);

    const save = seedPlayer(f, 'p-bp', (s) => {
      s.pvp.seasonPeakRank = 'bronze';
      s.pvp.seasonPeakElo = 1000;
      s.battlePass = bp;
    });
    const summary = await settleSeasonForPlayer(f.cols, commercial, socialsvc, 'p-bp', save, 4, 7_000);
    expect(summary.coins).toBe(expectedBpCoins);
    expect(socialsvc.mail.size).toBe(1);
    expect(socialsvc.mail.get('ladder.season.4.p-bp:p-bp')!.attachments)
      .toEqual([{ kind: 'coins', count: expectedBpCoins }]);
  });
});

describe('settleSeasonParticipants', () => {
  it('one player failing to settle is logged and skipped — the rest of the season still closes', async () => {
    // A season roll must never be aborted by one unreachable-mail player: the missed player is picked
    // up later by migrateIfStale on their next login (also idempotent).
    const f = makeCols();
    seedPlayer(f, 'p-fails', (s) => { s.pvp.seasonPeakRank = 'master'; s.pvp.seasonPeakElo = 1900; }); // earns coins -> mails
    seedPlayer(f, 'p-ok', (s) => { s.pvp.seasonPeakRank = 'bronze'; s.pvp.seasonPeakElo = 1000; }); // no mail needed
    const res = await settleSeasonParticipants(f.cols, commercial, new ThrowingSocialsvc(), 1, 100);
    expect(res).toEqual({ settled: 1, rewarded: 0 }); // only the mail-free player got through
    expect(await f.snaps.countDocuments()).toBe(1);
    expect(f.snaps.docs.get('1:p-ok')).toBeDefined();
    expect(f.snaps.docs.get('1:p-fails')).toBeUndefined(); // no snapshot -> re-settled on return
  });

  it('participant counts past the cursor buffer size are flushed in batches, settling every one', async () => {
    const f = makeCols();
    const socialsvc = new FakeSocialsvc();
    const total = 201; // > SETTLE_PARTICIPANTS_BATCH_SIZE (200), so the in-loop flush runs once
    for (let i = 0; i < total; i++) {
      seedPlayer(f, `pb${i}`, (s) => { s.pvp.seasonPeakRank = 'bronze'; s.pvp.seasonPeakElo = 1000; });
    }
    const res = await settleSeasonParticipants(f.cols, commercial, socialsvc, 1, 100);
    expect(res.settled).toBe(total); // nothing dropped at the batch boundary
    expect(await f.snaps.countDocuments()).toBe(total);
  });
});

describe('migrateIfStale', () => {
  const season = (seasonNo: number): LadderSeasonDoc => ({
    _id: 'current', seasonNo, startAt: 0, endAt: SEASON_DURATION_MS, state: 'active',
  });

  it('save with no pvp.seasonNo is treated as season 1 and migrated forward', async () => {
    const f = makeCols();
    const socialsvc = new FakeSocialsvc();
    const save = seedPlayer(f, 'p-noseason', (s) => {
      delete (s.pvp as Partial<SaveData['pvp']>).seasonNo;
      s.pvp.seasonPeakRank = 'bronze';
      s.pvp.seasonPeakElo = 1000;
    });
    const r = await migrateIfStale(f.cols, commercial, socialsvc, save, season(2), 9_000);
    expect(r.migrated).toBe(true);
    expect(r.save.pvp.seasonNo).toBe(2);
    expect(r.save.pvp.streak).toBe(0);
    expect(r.save.battlePass?.seasonNo).toBe(2);
    // The settlement it ran was for season 1 (the assumed previous season), not season 0/NaN.
    expect(r.save.titles).toBeDefined();
  });

  it('previous-season settlement failing does not block the migration (rewards are re-issued idempotently later)', async () => {
    const f = makeCols();
    const save = seedPlayer(f, 'p-settlefail', (s) => {
      s.pvp.seasonNo = 1;
      s.pvp.elo = 1900;
      s.pvp.seasonPeakRank = 'master';
      s.pvp.seasonPeakElo = 1900; // earns coins -> needs mail -> the throwing client rejects
    });
    const r = await migrateIfStale(f.cols, commercial, new ThrowingSocialsvc(), save, season(2), 9_000);
    expect(r.migrated).toBe(true);
    expect(r.save.pvp.seasonNo).toBe(2);
    expect(r.save.pvp.elo).toBeLessThan(1900); // soft reset applied regardless
  });
});
