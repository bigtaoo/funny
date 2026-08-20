// CityService.getTeams — the card-inventory lookup its self-heal performs (2026-08-02).
//
// getTeams sits on the CityScene critical path, and its self-heal used to ask metaserver for the
// account's ENTIRE cardInv (up to 500 instances, reassembled from the `cardInstances` collection)
// purely to check whether the ≤ SIEGE_TEAM_CAP × CARD_TEAM_MAX_SIZE ids its formations reference
// still resolve. It now passes those ids as `cardIds`, and skips the cross-service hop altogether
// when no team references a card at all.
//
// No Mongo: getTeams only touches `core.deps.cols.playerWorld.findOne` and `core.meta`, so a hand-
// built CityService over fakes covers it. The persisted-cleanup half (self-heal actually writing
// back) stays in teams.e2e.test.ts, which has a real database.
import { describe, expect, it, vi } from 'vitest';
import { SlgError, type CardInstance } from '@nw/shared';
import { CityService } from '../src/city';
import type { WorldCore } from '../src/core';
import type { PlayerWorldDoc, TeamTemplate } from '../src/db';

const W = 's1';
const ACC = 'acc-1';

function card(id: string): CardInstance {
  return { id, defId: 'lichuang', level: 1, gear: {}, locked: false } as unknown as CardInstance;
}

/** A CityService whose playerWorld doc holds `teams` and whose meta returns `cardInv`. */
function build(teams: TeamTemplate[] | undefined, cardInv: Record<string, CardInstance> | null = {}) {
  const updateOne = vi.fn(async () => ({}));
  const getSaveFields = vi.fn(async () => (cardInv === null ? null : { cardInv }));
  const core = {
    deps: {
      cols: {
        playerWorld: {
          findOne: async () => (teams === undefined ? null : ({ _id: `${W}:${ACC}`, teams } as unknown as PlayerWorldDoc)),
          updateOne,
        },
      },
    },
    meta: { getSaveFields },
  } as unknown as WorldCore;
  return { svc: new CityService(core), getSaveFields, updateOne };
}

function team(id: string, cardIds: string[]): TeamTemplate {
  return { id, name: id, army: cardIds.map((cid, i) => ({ cardInstanceId: cid, col: i, row: 0 })) } as TeamTemplate;
}

describe('CityService.getTeams — meta cardInv lookup narrowing (2026-08-02)', () => {
  it('asks meta only for the ids the formations actually reference, not the whole roster', async () => {
    const { svc, getSaveFields } = build(
      [team('t1', ['c1', 'c2']), team('t2', ['c3'])],
      { c1: card('c1'), c2: card('c2'), c3: card('c3') },
    );
    await svc.getTeams(W, ACC);
    expect(getSaveFields).toHaveBeenCalledTimes(1);
    const [accountId, fields, ids] = getSaveFields.mock.calls[0]! as unknown as [string, string[], string[]];
    expect(accountId).toBe(ACC);
    expect(fields).toEqual(['cardInv']);
    expect([...ids].sort()).toEqual(['c1', 'c2', 'c3']);
  });

  it('de-duplicates an id referenced by more than one team', async () => {
    // Cross-team duplicates are rejected on save (setTeams), but stored data predating that check —
    // or written by an older client — must not turn into a repeated id in the query string.
    const { svc, getSaveFields } = build([team('t1', ['c1']), team('t2', ['c1'])], { c1: card('c1') });
    await svc.getTeams(W, ACC);
    expect((getSaveFields.mock.calls[0] as unknown as [string, string[], string[]])[2]).toEqual(['c1']);
  });

  it('skips the cross-service hop entirely when the teams exist but reference no cards', async () => {
    const { svc, getSaveFields } = build([{ id: 't1', name: 'Alpha', army: [] } as TeamTemplate]);
    await svc.getTeams(W, ACC);
    expect(getSaveFields).not.toHaveBeenCalled();
  });

  it('still short-circuits before any lookup when there are no teams at all', async () => {
    const { svc, getSaveFields } = build([]);
    await expect(svc.getTeams(W, ACC)).resolves.toEqual([]);
    expect(getSaveFields).not.toHaveBeenCalled();
  });

  it('drops a leaderCardId that no longer sits in its own (empty) army, without asking meta', async () => {
    // withValidLeader runs on the no-cards path too — the lookup is skipped, not the self-heal.
    const { svc, updateOne } = build([
      { id: 't1', name: 'Alpha', army: [], leaderCardId: 'gone' } as unknown as TeamTemplate,
    ]);
    const out = await svc.getTeams(W, ACC);
    expect(out[0]!.leaderCardId).toBeUndefined();
    expect(updateOne).toHaveBeenCalledTimes(1);
  });

  it('drops an army entry whose card meta no longer reports as owned, and persists the cleanup', async () => {
    // c2 is referenced but absent from the (narrowed) cardInv meta returns = no longer owned.
    const { svc, updateOne } = build([team('t1', ['c1', 'c2'])], { c1: card('c1') });
    const out = await svc.getTeams(W, ACC);
    expect(out[0]!.army.map((e) => e.cardInstanceId)).toEqual(['c1']);
    expect(updateOne).toHaveBeenCalledTimes(1);
  });

  it('leaves a clean formation untouched — no write when nothing needed healing', async () => {
    const { svc, updateOne } = build([team('t1', ['c1'])], { c1: card('c1') });
    const out = await svc.getTeams(W, ACC);
    expect(out[0]!.army.map((e) => e.cardInstanceId)).toEqual(['c1']);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('meta unreachable → returns the stored teams verbatim and never writes (degrade, never destroy)', async () => {
    const { svc, updateOne } = build([team('t1', ['c1', 'c2'])], null);
    const out = await svc.getTeams(W, ACC);
    expect(out[0]!.army.map((e) => e.cardInstanceId)).toEqual(['c1', 'c2']);
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('player not in this world → TILE_NOT_OWNED, no lookup', async () => {
    const { svc, getSaveFields } = build(undefined);
    await expect(svc.getTeams(W, ACC)).rejects.toBeInstanceOf(SlgError);
    expect(getSaveFields).not.toHaveBeenCalled();
  });
});
