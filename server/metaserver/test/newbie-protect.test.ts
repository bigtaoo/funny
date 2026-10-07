// New-player ELO protection (SEASON_DESIGN_IMPL_SPEC.md §15.5, 2026-10-07): an account's first 3 settled ranked
// games never cost ELO. Calls settleElo() directly against FakeCollection so the shapes the real-Mongo
// e2e (newbie-protect.e2e.test.ts) can't force deterministically are pinned here:
//   - the window boundary (games 1..3 protected, game 4 not) and the streak rule;
//   - the opponent's swing is unaffected;
//   - a lost optimistic-lock race re-decides protection from the re-read doc (no double-claimed slot);
//   - botsvc accounts (deviceId `bot-NNNN`) are never protected; an unreadable accounts lookup fails open.
import { describe, it, expect } from 'vitest';
import {
  makeNewSave,
  computeEloDelta,
  NEWBIE_PROTECT_GAMES,
  type AccountDoc,
  type Collections,
  type LadderSeasonDoc,
  type SaveData,
  type SaveDoc,
} from '@nw/shared';
import { settleElo } from '../src/internal/matchReport/eloSettlement.js';
import { newbieProtectEligible, settledRankedGames } from '../src/newbieProtect.js';
import { FakeCollection } from './helpers/fakeCollection.js';
import { fakeCommercial, FakeSocialsvc } from './helpers/fakeClients.js';

const NOW = 1_700_000_000_000;
const now = () => NOW;
const WINNER = { side: 0, accountId: 'w' };
const LOSER = { side: 1, accountId: 'l' };
const SEASON: LadderSeasonDoc = { _id: 'current', seasonNo: 1, startAt: 0, endAt: NOW + 1, state: 'active' };

function doc(id: string, mutate: (s: SaveData) => void = () => {}): SaveDoc {
  const save = makeNewSave(id, NOW);
  mutate(save);
  return { _id: id, save, rev: save.rev };
}

const veteran = (s: SaveData): void => { s.pvp.wins = 20; s.pvp.losses = 20; };

function makeCols(docs: SaveDoc[], accounts: Array<Partial<AccountDoc> & { _id: string }> = []) {
  const saves = new FakeCollection<SaveDoc>().seed(...docs);
  const ladderSeasons = new FakeCollection<LadderSeasonDoc>().seed(SEASON);
  const accountsCol = new FakeCollection<AccountDoc>().seed(...(accounts as AccountDoc[]));
  return { cols: { saves, ladderSeasons, accounts: accountsCol } as unknown as Collections, saves, accountsCol };
}

const settle = (cols: Collections) => settleElo(cols, now, fakeCommercial(false), new FakeSocialsvc(), WINNER, LOSER);

describe('new-player protection - ranked settlement', () => {
  it('protects the first three settled games of a fresh loser and settles the fourth in full', async () => {
    const { cols, saves } = makeCols([doc('w', veteran), doc('l')], [{ _id: 'l', deviceId: 'uuid-human-1' }]);
    for (let game = 1; game <= NEWBIE_PROTECT_GAMES; game++) {
      const wBefore = saves.docs.get('w')!.save.pvp;
      const out = await settle(cols);
      expect(out[1]).toEqual({ delta: 0, after: 1000, rankAfter: 'bronze', protectedGame: game, protectedTotal: NEWBIE_PROTECT_GAMES });
      // Opponent unaffected: the winner's gain is exactly what computeEloDelta gives, unprotected, no label.
      expect(out[0]!.protectedGame).toBeUndefined();
      expect(out[0]!.delta).toBeGreaterThan(0);
      expect(out[0]!.after).toBe(wBefore.elo + out[0]!.delta);
      const l = saves.docs.get('l')!.save.pvp;
      expect(l.elo).toBe(1000);
      expect(l.losses).toBe(game); // the game still counts — it uses up the window
      expect(l.streak).toBe(0); // no losing streak builds up during the window
    }
    // Game 4: unprotected, and with streak 0 (not -3) the loss is the plain K=32 swing, not an amplified one.
    const wElo = saves.docs.get('w')!.save.pvp.elo;
    const out = await settle(cols);
    expect(out[1]!.protectedGame).toBeUndefined();
    expect(out[1]!.delta).toBe(computeEloDelta(wElo, 1000).loser);
    expect(out[1]!.delta).toBeLessThan(0);
    expect(saves.docs.get('l')!.save.pvp.streak).toBe(-1);
  });

  it('a protected win settles normally, is labelled, and uses up a slot', async () => {
    const { cols, saves } = makeCols([doc('w'), doc('l', veteran)]);
    const out = await settle(cols);
    expect(out[0]).toEqual({ delta: 16, after: 1016, rankAfter: 'bronze', protectedGame: 1, protectedTotal: 3 });
    expect(out[1]!.delta).toBe(-16); // veteran loser: normal
    expect(saves.docs.get('w')!.save.pvp.wins).toBe(1);
    expect(saves.docs.get('w')!.save.pvp.streak).toBe(1);
  });

  it('a protected loss breaks the win streak without starting a losing streak', async () => {
    const { cols, saves } = makeCols([doc('w', veteran), doc('l', (s) => { s.pvp.wins = 2; s.pvp.streak = 2; })]);
    const out = await settle(cols);
    expect(out[1]).toMatchObject({ delta: 0, protectedGame: 3 });
    expect(saves.docs.get('l')!.save.pvp.streak).toBe(0);
  });

  it('two fresh players: the winner gains normally, the loser is protected (not zero-sum by design)', async () => {
    const { cols } = makeCols([doc('w'), doc('l')]);
    const out = await settle(cols);
    expect(out[0]).toMatchObject({ delta: 16, protectedGame: 1 });
    expect(out[1]).toMatchObject({ delta: 0, protectedGame: 1 });
  });

  // Race safety: protection is decided against the doc the rev-guarded write is conditioned on. Here the
  // loser's last protected slot is consumed by a concurrent settlement between our read and our CAS —
  // the retry must see losses=3 and settle this game in full instead of claiming the slot again.
  it('re-decides protection after a lost CAS race (the last slot cannot be claimed twice)', async () => {
    const { cols, saves } = makeCols([doc('w', veteran), doc('l', (s) => { s.pvp.losses = 2; })]);
    const real = saves.findOneAndUpdate.bind(saves);
    let raced = false;
    saves.findOneAndUpdate = async (filter, update, opts) => {
      if (filter._id === 'l' && !raced) {
        raced = true;
        // A concurrent settlement of another match lands first and consumes slot 3.
        const d = saves.docs.get('l')!;
        d.save = { ...d.save, rev: d.save.rev + 1, pvp: { ...d.save.pvp, losses: 3 } };
        d.rev = d.save.rev;
        return null;
      }
      return real(filter, update, opts);
    };
    const out = await settle(cols);
    expect(raced).toBe(true);
    expect(out[1]!.protectedGame).toBeUndefined();
    expect(out[1]!.delta).toBe(-16);
    expect(saves.docs.get('l')!.save.pvp.losses).toBe(4);
    expect(saves.docs.get('l')!.save.pvp.elo).toBe(984);
  });

  it('never protects a botsvc account (deviceId bot-NNNN), on either side', async () => {
    const { cols } = makeCols(
      [doc('w'), doc('l')],
      [{ _id: 'w', deviceId: 'bot-0001' }, { _id: 'l', deviceId: 'bot-0002' }],
    );
    const out = await settle(cols);
    expect(out[0]).toEqual({ delta: 16, after: 1016, rankAfter: 'bronze' });
    expect(out[1]).toEqual({ delta: -16, after: 984, rankAfter: 'bronze' });
  });
});

describe('newbieProtectEligible', () => {
  it('skips the accounts read entirely once the window is used up', async () => {
    let reads = 0;
    const cols = { accounts: { findOne: async () => { reads++; return null; } } } as unknown as Collections;
    expect(await newbieProtectEligible(cols, 'x', { wins: 2, losses: 1 })).toBe(false);
    expect(reads).toBe(0);
    expect(await newbieProtectEligible(cols, 'x', { wins: 1, losses: 1 })).toBe(true);
    expect(reads).toBe(1);
  });

  it('fails open when the accounts lookup throws (a fresh save is still a fresh player)', async () => {
    const cols = { accounts: { findOne: async () => { throw new Error('mongo down'); } } } as unknown as Collections;
    expect(await newbieProtectEligible(cols, 'x', { wins: 0, losses: 0 })).toBe(true);
  });

  it('settledRankedGames tolerates a missing pvp block', () => {
    expect(settledRankedGames(undefined)).toBe(0);
    expect(settledRankedGames({ wins: 4, losses: 7 })).toBe(11);
  });
});
