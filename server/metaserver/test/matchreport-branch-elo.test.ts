// Branch-coverage backfill for src/internal/matchReport/eloSettlement.ts (2026-09-03).
// Everything that already covers this file goes through the HTTP handler (test/internal.test.ts), which
// only ever reports a *pair of fully-populated modern save docs* against a *healthy* commercial client
// and never loses an optimistic-lock race. So all three shapes below were unexercised:
//   (a) absent-field fallbacks — the save doc is missing entirely, or is a pre-S11 save with no
//       seasonNo/seasonPeakElo/reachedRanks/battlePass;
//   (b) degraded dependencies — the season clock is unreadable, victoryCredit/grant reject;
//   (c) lost CAS races — a concurrent client PUT /save bumps `rev` between our read and our write.
// These call settleElo() directly so each of those can be forced deterministically.
import { describe, it, expect } from 'vitest';
import {
  makeNewSave,
  accrueRetentionTask,
  xpToLevel,
  BP_XP_PER_RANKED_WIN,
  BP_XP_PER_RANKED_LOSS,
  type Collections,
  type SaveData,
  type SaveDoc,
  type LadderSeasonDoc,
  type RankId,
} from '@nw/shared';
import { settleElo } from '../src/internal/matchReport/eloSettlement.js';
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

/** cols carrying just what settleElo touches: saves (findOne + CAS findOneAndUpdate) and the season clock. */
function makeCols(docs: SaveDoc[], seasonCol?: unknown) {
  const saves = new FakeCollection<SaveDoc>().seed(...docs);
  const ladderSeasons = seasonCol ?? new FakeCollection<LadderSeasonDoc>().seed(SEASON);
  return { cols: { saves, ladderSeasons } as unknown as Collections, saves };
}

function socialsvc() {
  return new FakeSocialsvc();
}

describe('eloSettlement branch backfill', () => {
  // (a) Both accounts were deleted between match end and the report (or the report names accounts that
  // never had a save). settleElo must degrade to "nothing to settle" rather than inventing docs — the
  // archived match then carries no eloDelta for either side.
  it('reports no elo at all when neither side has a save doc', async () => {
    const { cols, saves } = makeCols([]);
    const commercial = fakeCommercial(true);
    const out = await settleElo(cols, now, commercial, socialsvc(), WINNER, LOSER);
    expect(out).toEqual({});
    expect(saves.docs.size).toBe(0);
    // No winner result → no ranked-victory coin credit either.
    expect(commercial.grantCalls).toHaveLength(0);
  });

  // Each side's own incoming streak scales only its own half of the swing (ECONOMY_BALANCE §2.3):
  // winnerK = 32 * streakMultiplier(2) = 41.6 → +21, loserK = 32 * streakMultiplier(3) = 51.2 → -26,
  // on an even 1000/1000 matchup. Deliberately not zero-sum.
  it('accelerates each side of the swing by that side own streak only', async () => {
    const { cols } = makeCols([
      doc('w', (s) => { s.pvp.streak = 2; }),
      doc('l', (s) => { s.pvp.streak = -3; }),
    ]);
    const out = await settleElo(cols, now, fakeCommercial(false), socialsvc(), WINNER, LOSER);
    expect(out[0]!.delta).toBe(21);
    expect(out[1]!.delta).toBe(-26);
  });

  // Lazy season migration fires mid-settlement (the save is a season behind): settlement must persist the
  // migrated save *before* the ELO write, otherwise the soft reset / season rewards are silently lost.
  // Observable: previous-season reward mail + season title land, seasonNo advances, and the ELO delta is
  // applied on top of the soft-reset ELO (1300 → softReset 1250), not on top of the stale 1300. Note the
  // delta itself (+5) is computed from the *pre*-migration 1300 vs the opponent's 1000 — settleElo reads
  // both sides' ELO before applyPvp runs the migration, so a stale player's swing is sized off last
  // season's rating. Pinned here as current behaviour.
  it('persists a lazy season migration before applying the ELO delta', async () => {
    const social = socialsvc();
    const seasons = new FakeCollection<LadderSeasonDoc>().seed({ ...SEASON, seasonNo: 2 });
    const { cols, saves } = makeCols(
      [
        doc('w', (s) => {
          s.pvp.elo = 1300;
          s.pvp.seasonNo = 1;
          // Gold peak → seasonPeakCoins > 0, so the season-close reward mail is actually dispatched.
          s.pvp.seasonPeakElo = 1300;
          s.pvp.seasonPeakRank = 'gold';
        }),
        doc('l', (s) => { s.pvp.seasonNo = 2; }),
      ],
      seasons,
    );
    const out = await settleElo(cols, now, fakeCommercial(false), social, WINNER, LOSER);
    expect(out[0]!.after).toBe(1255);
    const w = saves.docs.get('w')!.save;
    expect(w.pvp.seasonNo).toBe(2);
    expect(w.pvp.elo).toBe(1255);
    expect(w.titles).toContain('ladder.s1.gold');
    expect([...social.mail.keys()]).toContain('ladder.season.1.w:w');
  });

  // Wallet is commercial-authoritative and reconciled on the next GET /save, so a 503 from the coin
  // credit must not roll back or block the ELO write the player already saw in match_over.
  it('still settles ELO when the ranked-victory coin credit throws', async () => {
    const { cols, saves } = makeCols([doc('w'), doc('l')]);
    const commercial = fakeCommercial(true);
    (commercial as unknown as { victoryCredit: () => Promise<never> }).victoryCredit = async () => {
      throw new Error('commercial 503');
    };
    const out = await settleElo(cols, now, commercial, socialsvc(), WINNER, LOSER);
    expect(out[0]!.after).toBe(1016);
    expect(saves.docs.get('w')!.save.pvp.elo).toBe(1016);
  });

  // (a) Pre-S11 save: no seasonNo / seasonPeakElo / reachedRanks. Settlement must materialize all three
  // rather than writing `undefined` into pvp (which would then break eloToRank/first-reach on the next match).
  it('materializes the S11 season fields on a pre-S11 save', async () => {
    const { cols, saves } = makeCols([
      doc('w', (s) => {
        delete (s.pvp as { seasonNo?: number }).seasonNo;
        delete (s.pvp as { seasonPeakElo?: number }).seasonPeakElo;
        delete (s.pvp as { reachedRanks?: RankId[] }).reachedRanks;
      }),
      doc('l'),
    ]);
    const out = await settleElo(cols, now, fakeCommercial(false), socialsvc(), WINNER, LOSER);
    const pvp = saves.docs.get('w')!.save.pvp;
    expect(out[0]!.after).toBe(1016);
    expect(pvp.seasonNo).toBe(1); // filled from the live season clock
    expect(pvp.seasonPeakElo).toBe(1016); // no prior peak → the post-match ELO becomes the peak
    expect(pvp.reachedRanks).toEqual(['bronze']);
  });

  // (b) Season clock unreadable (Mongo hiccup). getCurrentSeason is best-effort — settlement proceeds
  // without lazy migration, and a save with no seasonNo falls back to season 1 rather than to `undefined`.
  it('settles without a season clock and defaults seasonNo to 1', async () => {
    const brokenSeasons = {
      findOne: async () => { throw new Error('mongo unavailable'); },
      updateOne: async () => { throw new Error('mongo unavailable'); },
    };
    const { cols, saves } = makeCols(
      [doc('w', (s) => { delete (s.pvp as { seasonNo?: number }).seasonNo; }), doc('l')],
      brokenSeasons,
    );
    const out = await settleElo(cols, now, fakeCommercial(false), socialsvc(), WINNER, LOSER);
    expect(out[0]!.after).toBe(1016);
    expect(saves.docs.get('w')!.save.pvp.seasonNo).toBe(1);
  });

  // First-reach coins are a lifetime one-off: a player whose ledger already covers the rank they land on
  // gets no grant and the ledger array is written back untouched (no duplicate entries accumulating).
  it('grants nothing and leaves reachedRanks untouched when the rank was already reached', async () => {
    const { cols, saves } = makeCols([
      doc('w', (s) => { s.pvp.reachedRanks = ['bronze']; }),
      doc('l'),
    ]);
    const commercial = fakeCommercial(true);
    await settleElo(cols, now, commercial, socialsvc(), WINNER, LOSER);
    expect(saves.docs.get('w')!.save.pvp.reachedRanks).toEqual(['bronze']);
    expect(commercial.grantCalls.filter((g) => g.accountId === 'w')).toHaveLength(0);
  });

  // Every ranked match feeds season XP (§C). Both sides must be credited — the loser too, just less —
  // and the stored level recomputed from the new total.
  it('accrues battle-pass XP for both sides and recomputes the level', async () => {
    const bp = (xp: number) => ({ seasonNo: 1, xp, level: xpToLevel(xp), hasPass: false, claimedFree: [], claimedPaid: [] });
    const { cols, saves } = makeCols([
      doc('w', (s) => { s.battlePass = bp(550); }),
      doc('l', (s) => { s.battlePass = bp(0); }),
    ]);
    await settleElo(cols, now, fakeCommercial(false), socialsvc(), WINNER, LOSER);
    const w = saves.docs.get('w')!.save.battlePass!;
    expect(w.xp).toBe(550 + BP_XP_PER_RANKED_WIN);
    expect(w.level).toBe(xpToLevel(550 + BP_XP_PER_RANKED_WIN));
    expect(saves.docs.get('l')!.save.battlePass!.xp).toBe(BP_XP_PER_RANKED_LOSS);
  });

  // The 'pvp.match' daily task is idempotent: a player's second ranked match of the day must not
  // re-award task points, and settlement must then leave the retention subtree byte-identical.
  it('does not re-accrue the daily pvp.match task on a second match the same day', async () => {
    const already = accrueRetentionTask(undefined, 'pvp.match', NOW);
    const { cols, saves } = makeCols([doc('w', (s) => { s.retention = already; }), doc('l')]);
    await settleElo(cols, now, fakeCommercial(false), socialsvc(), WINNER, LOSER);
    // Same object reference: accrueRetentionTask returned the input unchanged, so settlement skipped the write.
    expect(saves.docs.get('w')!.save.retention).toBe(already);
    expect(already!.daily!.taskPoints).toBe(saves.docs.get('w')!.save.retention!.daily!.taskPoints);
  });

  // (b) A rejected first-reach grant is swallowed: the ELO/ledger write has already committed, so the
  // reachedRanks entry is recorded while the coins are lost — at-most-once by design (the ledger is the
  // dedup key, so a retry would not re-grant either). Operators see the error log, the player sees no coins.
  it('records the reachedRanks entry even when the first-reach coin grant throws', async () => {
    const { cols, saves } = makeCols([doc('w'), doc('l')]);
    const commercial = fakeCommercial(true);
    (commercial as unknown as { grant: () => Promise<never> }).grant = async () => {
      throw new Error('commercial 503');
    };
    const out = await settleElo(cols, now, commercial, socialsvc(), WINNER, LOSER);
    expect(out[0]!.after).toBe(1016);
    expect(saves.docs.get('w')!.save.pvp.reachedRanks).toEqual(['bronze']);
  });

  // (c) A concurrent client PUT /save lands between our read and our CAS write. applyPvp must re-read
  // and retry rather than clobber the client's write — the ELO delta still lands, on top of rev 1.
  it('retries after one lost optimistic-lock race and still applies the delta', async () => {
    const { cols, saves } = makeCols([doc('w'), doc('l')]);
    const real = saves.findOneAndUpdate.bind(saves);
    let stolen = false;
    saves.findOneAndUpdate = async (filter, update, opts) => {
      if (filter._id === 'w' && !stolen) {
        stolen = true;
        // Simulate the concurrent PUT /save: it bumps rev, so our CAS filter no longer matches.
        const d = saves.docs.get('w')!;
        d.save = { ...d.save, rev: d.save.rev + 1 };
        d.rev = d.save.rev;
        return null;
      }
      return real(filter, update, opts);
    };
    const out = await settleElo(cols, now, fakeCommercial(false), socialsvc(), WINNER, LOSER);
    expect(out[0]!.after).toBe(1016);
    expect(saves.docs.get('w')!.save.pvp.elo).toBe(1016);
    expect(saves.docs.get('w')!.save.rev).toBe(2); // rev 0 → stolen to 1 → settled to 2
  });

  // (c) Three straight CAS losses (a save under sustained concurrent writes) → that side gives up.
  // The opponent still settles, so the archived match ends up with a one-sided eloDelta — the shape
  // an operator sees in match history when this happens.
  it('gives up after three lost races, leaving the opponent settled one-sided', async () => {
    const { cols, saves } = makeCols([doc('w'), doc('l')]);
    const real = saves.findOneAndUpdate.bind(saves);
    saves.findOneAndUpdate = async (filter, update, opts) => {
      if (filter._id === 'w') return null;
      return real(filter, update, opts);
    };
    const out = await settleElo(cols, now, fakeCommercial(true), socialsvc(), WINNER, LOSER);
    expect(out[0]).toBeUndefined();
    expect(out[1]!.delta).toBe(-16);
    expect(saves.docs.get('w')!.save.pvp.elo).toBe(1000); // untouched
  });
});
