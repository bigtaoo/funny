// ELO-loss protection (SEASON_DESIGN_IMPL_SPEC.md §15.5, 2026-10-07): new-player slots (an account's first 3
// settled ranked games) then daily slots (first 3 settled ranked games of each server-UTC day that weren't
// new-player games); a protected loss costs no ELO. Calls settleElo() directly against FakeCollection so the
// shapes the real-Mongo e2e (elo-protect.e2e.test.ts) can't force deterministically are pinned here:
//   - slot order (new-player first, then daily, each game uses at most one) and the day-1 / day-2 sequence;
//   - the daily boundary at exactly 3, the lazy day rollover, and the streak rule;
//   - the opponent's swing is unaffected;
//   - a lost optimistic-lock race re-decides the slot from the re-read doc (no double-claimed last slot);
//   - botsvc accounts (deviceId `bot-NNNN`) are never protected; an unreadable accounts lookup fails open.
import { describe, it, expect } from 'vitest';
import {
  makeNewSave,
  makeDayKey,
  computeEloDelta,
  NEWBIE_PROTECT_GAMES,
  DAILY_PROTECT_GAMES,
  PROTECT_KIND_NEWBIE,
  PROTECT_KIND_DAILY,
  type AccountDoc,
  type Collections,
  type LadderSeasonDoc,
  type SaveData,
  type SaveDoc,
} from '@nw/shared';
import { settleElo } from '../src/internal/matchReport/eloSettlement.js';
import { eloProtectEligible, protectDayKey, settledRankedGames } from '../src/eloProtect.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { fakeCommercial, FakeSocialsvc } from './helpers/fakeClients.js';

const DAY1 = Date.UTC(2026, 9, 7, 12, 0, 0);
const DAY_MS = 86_400_000;
const clock = { t: DAY1 };
const now = () => clock.t;
const WINNER = { side: 0, accountId: 'w' };
const LOSER = { side: 1, accountId: 'l' };
const SEASON: LadderSeasonDoc = { _id: 'current', seasonNo: 1, startAt: 0, endAt: DAY1 + 30 * DAY_MS, state: 'active' };

function doc(id: string, mutate: (s: SaveData) => void = () => {}): SaveDoc {
  const save = makeNewSave(id, DAY1);
  mutate(save);
  return { _id: id, save, rev: save.rev };
}

/** Past the new-player pool and with today's daily slots already spent: every loss settles in full. */
const veteran = (s: SaveData): void => {
  s.pvp.wins = 20;
  s.pvp.losses = 20;
  s.pvp.dailyProtect = { dayKey: makeDayKey(clock.t), used: DAILY_PROTECT_GAMES };
};

function makeCols(docs: SaveDoc[], accounts: Array<Partial<AccountDoc> & { _id: string }> = []) {
  const saves = new FakeCollection<SaveDoc>().seed(...docs);
  const ladderSeasons = new FakeCollection<LadderSeasonDoc>().seed(SEASON);
  const accountsCol = new FakeCollection<AccountDoc>().seed(...(accounts as AccountDoc[]));
  return { cols: { saves, ladderSeasons, accounts: accountsCol } as unknown as Collections, saves, accountsCol };
}

const settle = (cols: Collections) => settleElo(cols, now, fakeCommercial(false), new FakeSocialsvc(), WINNER, LOSER);

describe('ELO-loss protection - ranked settlement', () => {
  it('a new account on day 1: games 1-3 new-player, 4-6 daily, 7 in full; day 2 gives 3 daily slots again', async () => {
    clock.t = DAY1;
    const { cols, saves } = makeCols([doc('w', veteran), doc('l')], [{ _id: 'l', deviceId: 'uuid-human-1' }]);
    const labels: string[] = [];
    for (let game = 1; game <= 6; game++) {
      const wBefore = saves.docs.get('w')!.save.pvp;
      const out = await settle(cols);
      expect(out[1]).toMatchObject({ delta: 0, after: 1000, rankAfter: 'bronze' });
      labels.push(`${out[1]!.protectedKind}:${out[1]!.protectedGame}/${out[1]!.protectedTotal}`);
      // Opponent unaffected: the winner's gain is the normal one, unlabelled.
      expect(out[0]!.protectedGame).toBeUndefined();
      expect(out[0]!.delta).toBeGreaterThan(0);
      expect(out[0]!.after).toBe(wBefore.elo + out[0]!.delta);
      const l = saves.docs.get('l')!.save.pvp;
      expect(l.losses).toBe(game); // every game still counts
      expect(l.streak).toBe(0); // no losing streak builds up while protected
    }
    expect(labels).toEqual([
      `${PROTECT_KIND_NEWBIE}:1/3`, `${PROTECT_KIND_NEWBIE}:2/3`, `${PROTECT_KIND_NEWBIE}:3/3`,
      `${PROTECT_KIND_DAILY}:1/3`, `${PROTECT_KIND_DAILY}:2/3`, `${PROTECT_KIND_DAILY}:3/3`,
    ]);
    // Only the daily games advanced the daily counter.
    expect(saves.docs.get('l')!.save.pvp.dailyProtect).toEqual({ dayKey: '2026-10-07', used: 3 });

    // Game 7: both pools spent — the loss is the plain K=32 swing (streak 0, not -6, so no amplification).
    const wElo = saves.docs.get('w')!.save.pvp.elo;
    const g7 = await settle(cols);
    expect(g7[1]!.protectedGame).toBeUndefined();
    expect(g7[1]!.protectedKind).toBeUndefined();
    expect(g7[1]!.delta).toBe(computeEloDelta(wElo, 1000).loser);
    expect(saves.docs.get('l')!.save.pvp.streak).toBe(-1);
    expect(saves.docs.get('l')!.save.pvp.dailyProtect).toEqual({ dayKey: '2026-10-07', used: 3 });

    // Day 2 (the winner's veteran daily state is from day 1 too, so re-spend it to keep it a plain veteran).
    clock.t = DAY1 + DAY_MS;
    const w = saves.docs.get('w')!;
    w.save = { ...w.save, pvp: { ...w.save.pvp, dailyProtect: { dayKey: makeDayKey(clock.t), used: 3 } } };
    const eloBefore = saves.docs.get('l')!.save.pvp.elo;
    for (let game = 1; game <= DAILY_PROTECT_GAMES; game++) {
      const out = await settle(cols);
      expect(out[1]).toMatchObject({ delta: 0, after: eloBefore, protectedGame: game, protectedTotal: 3, protectedKind: PROTECT_KIND_DAILY });
    }
    expect(saves.docs.get('l')!.save.pvp.dailyProtect).toEqual({ dayKey: '2026-10-08', used: 3 });
    const g4 = await settle(cols);
    expect(g4[1]!.protectedGame).toBeUndefined();
    expect(g4[1]!.delta).toBeLessThan(0);
  });

  it('a veteran: exactly the first 3 games of the day are protected (boundary at 3), wins use a slot too', async () => {
    clock.t = DAY1;
    const vetY = (s: SaveData): void => { s.pvp.wins = 30; s.pvp.losses = 30; s.pvp.dailyProtect = { dayKey: '2026-10-06', used: 3 }; };
    const { cols, saves } = makeCols([doc('w', vetY), doc('l', veteran)]);
    // Game 1: 'w' wins — normal gain (K=32 at equal ELO), labelled daily 1/3; the loser's loss is unprotected.
    const g1 = await settle(cols);
    expect(g1[0]).toEqual({ delta: 16, after: 1016, rankAfter: 'bronze', protectedGame: 1, protectedTotal: 3, protectedKind: PROTECT_KIND_DAILY });
    expect(g1[1]).toEqual({ delta: -16, after: 984, rankAfter: 'bronze' });
    expect(saves.docs.get('w')!.save.pvp.dailyProtect).toEqual({ dayKey: '2026-10-07', used: 1 });
    // Swap roles so 'w' (accountId) now loses: games 2 and 3 are free, game 4 is not.
    const swap = () => settleElo(cols, now, fakeCommercial(false), new FakeSocialsvc(), { side: 0, accountId: 'l' }, { side: 1, accountId: 'w' });
    for (const game of [2, 3]) {
      const out = await swap();
      expect(out[1]).toMatchObject({ delta: 0, protectedGame: game, protectedKind: PROTECT_KIND_DAILY });
    }
    const g4 = await swap();
    expect(g4[1]!.protectedGame).toBeUndefined();
    expect(g4[1]!.delta).toBeLessThan(0);
    expect(saves.docs.get('w')!.save.pvp.dailyProtect).toEqual({ dayKey: '2026-10-07', used: 3 });
  });

  it('a protected loss breaks the win streak without starting a losing streak', async () => {
    clock.t = DAY1;
    const { cols, saves } = makeCols([
      doc('w', veteran),
      doc('l', (s) => { s.pvp.wins = 12; s.pvp.streak = 2; s.pvp.dailyProtect = { dayKey: '2026-10-07', used: 2 }; }),
    ]);
    const out = await settle(cols);
    expect(out[1]).toMatchObject({ delta: 0, protectedGame: 3, protectedKind: PROTECT_KIND_DAILY });
    expect(saves.docs.get('l')!.save.pvp.streak).toBe(0);
  });

  it('a new-player game does not touch the daily counter', async () => {
    clock.t = DAY1;
    const { cols, saves } = makeCols([
      doc('w', veteran),
      doc('l', (s) => { s.pvp.losses = 1; s.pvp.dailyProtect = { dayKey: '2026-10-05', used: 1 }; }),
    ]);
    const out = await settle(cols);
    expect(out[1]).toMatchObject({ delta: 0, protectedGame: 2, protectedTotal: NEWBIE_PROTECT_GAMES, protectedKind: PROTECT_KIND_NEWBIE });
    expect(saves.docs.get('l')!.save.pvp.dailyProtect).toEqual({ dayKey: '2026-10-05', used: 1 });
  });

  it('two fresh players: the winner gains normally, the loser is protected (not zero-sum by design)', async () => {
    clock.t = DAY1;
    const { cols } = makeCols([doc('w'), doc('l')]);
    const out = await settle(cols);
    expect(out[0]).toMatchObject({ delta: 16, protectedGame: 1, protectedKind: PROTECT_KIND_NEWBIE });
    expect(out[1]).toMatchObject({ delta: 0, protectedGame: 1, protectedKind: PROTECT_KIND_NEWBIE });
  });

  // Race safety: the slot is decided against the doc the rev-guarded write is conditioned on. Here the
  // loser's last daily slot is consumed by a concurrent settlement between our read and our CAS — the
  // retry must see used=3 and settle this game in full instead of claiming the slot again.
  it('re-decides the slot after a lost CAS race (the last daily slot cannot be claimed twice)', async () => {
    clock.t = DAY1;
    const { cols, saves } = makeCols([
      doc('w', veteran),
      doc('l', (s) => { s.pvp.losses = 10; s.pvp.dailyProtect = { dayKey: '2026-10-07', used: 2 }; }),
    ]);
    const real = saves.findOneAndUpdate.bind(saves);
    let raced = false;
    saves.findOneAndUpdate = async (filter, update, opts) => {
      if (filter._id === 'l' && !raced) {
        raced = true;
        // A concurrent settlement of another match lands first and consumes daily slot 3.
        const d = saves.docs.get('l')!;
        d.save = { ...d.save, rev: d.save.rev + 1, pvp: { ...d.save.pvp, losses: 11, dailyProtect: { dayKey: '2026-10-07', used: 3 } } };
        d.rev = d.save.rev;
        return null;
      }
      return real(filter, update, opts);
    };
    const out = await settle(cols);
    expect(raced).toBe(true);
    expect(out[1]!.protectedGame).toBeUndefined();
    expect(out[1]!.delta).toBe(-16);
    const l = saves.docs.get('l')!.save.pvp;
    expect(l.losses).toBe(12);
    expect(l.elo).toBe(984);
    expect(l.dailyProtect).toEqual({ dayKey: '2026-10-07', used: 3 });
  });

  it('never protects a botsvc account (deviceId bot-NNNN), on either side', async () => {
    clock.t = DAY1;
    const { cols, saves } = makeCols(
      [doc('w'), doc('l')],
      [{ _id: 'w', deviceId: 'bot-0001' }, { _id: 'l', deviceId: 'bot-0002' }],
    );
    const out = await settle(cols);
    expect(out[0]).toEqual({ delta: 16, after: 1016, rankAfter: 'bronze' });
    expect(out[1]).toEqual({ delta: -16, after: 984, rankAfter: 'bronze' });
    expect(saves.docs.get('l')!.save.pvp.dailyProtect).toBeUndefined();
  });
});

describe('eloProtectEligible', () => {
  const D = '2026-10-07';
  it('skips the accounts read entirely once both pools are used up for the day', async () => {
    let reads = 0;
    const cols = { accounts: { findOne: async () => { reads++; return null; } } } as unknown as Collections;
    expect(await eloProtectEligible(cols, 'x', { wins: 2, losses: 1, dailyProtect: { dayKey: D, used: 3 } }, D)).toBe(false);
    expect(reads).toBe(0);
    // Same counts, but yesterday's daily state: today's slots are open again.
    expect(await eloProtectEligible(cols, 'x', { wins: 2, losses: 1, dailyProtect: { dayKey: '2026-10-06', used: 3 } }, D)).toBe(true);
    expect(await eloProtectEligible(cols, 'x', { wins: 1, losses: 1 }, D)).toBe(true);
    expect(reads).toBe(2);
  });

  it('fails open when the accounts lookup throws', async () => {
    const cols = { accounts: { findOne: async () => { throw new Error('mongo down'); } } } as unknown as Collections;
    expect(await eloProtectEligible(cols, 'x', { wins: 0, losses: 0 }, D)).toBe(true);
  });

  it('settledRankedGames tolerates a missing pvp block; protectDayKey is the server-UTC day', () => {
    expect(settledRankedGames(undefined)).toBe(0);
    expect(settledRankedGames({ wins: 4, losses: 7 })).toBe(11);
    expect(protectDayKey(Date.UTC(2026, 9, 7, 23, 59, 59))).toBe('2026-10-07');
    expect(protectDayKey(Date.UTC(2026, 9, 8, 0, 0, 0))).toBe('2026-10-08');
  });
});
