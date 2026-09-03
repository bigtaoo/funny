/**
 * `game/meta/**` + `game/campaign/progress.ts` — the defensive arms of the save-derived helpers.
 *
 * Twenty-five branches spread one or two per file, and they are all the same kind of thing: what
 * these functions do when the save they are reading is not the shape today's client writes.
 * `stats` absent, `achievements` absent, `cardInv` absent, a card referencing a `defId` this build
 * does not know, a team entry pointing at a card that is no longer in the inventory, a title id
 * from a season this build has never heard of, a `version` field that is not a number.
 *
 * Every one of those is reachable in the field: saves migrate forward, the server ships new card
 * and title ids before the client that renders them, and a client-side team edit can be one round
 * trip ahead of the inventory it references. The failure mode is uniform and bad — these are
 * called from scene construction, so an unguarded read is a blank screen on a real account, not a
 * test failure. The point of each case below is that the degraded answer is the RIGHT one (0, [],
 * skip the entry) rather than a throw or a NaN that renders as "NaN troops".
 */
import { describe, it, expect } from 'vitest';
import {
  CARD_DEFS,
  cardPower,
  fusionMaterialCandidates,
  toEngineCardInstances,
} from '../src/game/meta/cardDefs';
import { achievementClaimable, hasClaimable, reachedTierKeys, tierState } from '../src/game/meta/achievements';
import { computeStarScore, computeStars } from '../src/game/meta/campaignRewards';
import { carriedTroops, teamLeaderCard, teamTroopCap } from '../src/game/meta/teamTroops';
import { formatLadderTitle, getTitleKeys, titleWeight } from '../src/game/meta/titles';
import { migrate } from '../src/game/meta/migrate';
import { affixKind } from '../src/game/meta/equipmentDefs';
import {
  PVP_BASE_CARDS,
  PVP_BUILDING_CARDS,
  PVP_SPELL_CARDS,
  validatePvpDeckClient,
} from '../src/game/meta/pvpLoadout';
import { ReplayStore } from '../src/game/meta/ReplayStore';
import {
  currentChapter,
  currentLevelIdInChapter,
  isFirstChapterCleared,
  isLevelUnlocked,
  parseLevelId,
} from '../src/game/campaign/progress';
import { CHAPTER_ORDER } from '../src/game/campaign/maps';
import type { Achievement } from '../src/game/meta/achievements';
import type { CardInstance, SaveData } from '../src/game/meta/SaveData';
import type { CardSLGState } from '../src/net/WorldApiClient';
import type { IStorage } from '../src/platform/IPlatform';
import type { Replay } from '@nw/engine/types';
import type { StarContext } from '../src/game/meta/campaignRewards';

function card(id: string, defId: string, level = 1, over: Partial<CardInstance> = {}): CardInstance {
  return { id, defId, level, gear: {}, locked: false, ...over };
}

// ── cardDefs ────────────────────────────────────────────────────────────────────────────────

describe('cardDefs with an unknown defId', () => {
  it('offers no fusion materials for a card this build cannot identify', () => {
    // Without the guard the next line reads `def.faction` off undefined and the fuse panel dies
    // on open for anyone holding a card from a newer release.
    const unknown = card('u', 'a_hero_from_the_future', 2);
    const inv = { u: unknown, a: card('a', 'max', 2), b: card('b', 'lena', 2) };
    expect(fusionMaterialCandidates(unknown, inv)).toEqual([]);
    // A known card in the same inventory still finds its materials.
    expect(fusionMaterialCandidates(inv.a!, inv).map((c) => c.id)).toEqual(['b']);
  });

  it('scores an unknown card as 0 power rather than NaN', () => {
    // NaN would poison every sort that touches the roster grid, and sorts do not throw — the grid
    // would just come out in a random order.
    expect(cardPower(card('u', 'nope', 5))).toBe(0);
    expect(cardPower(card('k', 'max', 5))).toBeGreaterThan(0);
  });

  it('skips an unknown card when building the engine roster instead of sending a bad unitType', () => {
    // The engine indexes its blueprint table by unitType; `undefined` there would silently mean
    // "no progression for this unit", which is a quietly weaker PvE run.
    const inv = { u: card('u', 'nope', 3), k: card('k', 'max', 3) };
    expect(toEngineCardInstances(inv).map((c) => c.defId)).toEqual(['max']);
  });

  it('handles an absent cardInv as an empty roster', () => {
    expect(toEngineCardInstances(undefined)).toEqual([]);
  });

  it('ignores an empty gear slot and a dangling equipment id when scoring power', () => {
    const withHoles = card('c', 'max', 1, { gear: { weapon: undefined, armor: 'gone' } });
    expect(cardPower(withHoles, {})).toBe(cardPower(card('c', 'max', 1), {}));
  });
});

// ── achievements ────────────────────────────────────────────────────────────────────────────

describe('achievements with a partial save', () => {
  const def: Achievement = {
    id: 'kills',
    statKey: 'kill.total',
    category: 'pve',
    tiers: [{ threshold: 10, coins: 5 }, { threshold: 100, coins: 50 }],
  } as Achievement;

  it('treats an absent stats block as zero progress rather than throwing', () => {
    // `stats` is backfilled by fillDefaults, but the achievements screen also renders from a
    // freshly-created save and from a server response mid-flight.
    const states = tierState(def, undefined as unknown as SaveData['stats'], []);
    expect(states.map((s) => s.progress)).toEqual([0, 0]);
    expect(states.every((s) => !s.reached && !s.claimable)).toBe(true);
  });

  it('treats a missing stat key as zero while other keys still count', () => {
    const states = tierState(def, { 'kill.archer': 999 } as SaveData['stats'], []);
    expect(states[0]!.reached).toBe(false);
  });

  it('treats an absent achievements block as nothing claimed', () => {
    const stats = { 'kill.total': 50 } as SaveData['stats'];
    expect(achievementClaimable(def, stats, undefined as unknown as SaveData['achievements'])).toBe(true);
    // ...and an entry with no claimedTiers array behaves the same way.
    expect(achievementClaimable(def, stats, { kills: {} } as unknown as SaveData['achievements'])).toBe(true);
    // Claiming tier 1 removes the badge again.
    expect(
      achievementClaimable(def, stats, { kills: { claimedTiers: [1] } } as unknown as SaveData['achievements']),
    ).toBe(false);
  });

  it('aggregates the entry badge over several definitions', () => {
    const stats = { 'kill.total': 50 } as SaveData['stats'];
    const other = { ...def, id: 'other', statKey: 'nothing' } as Achievement;
    expect(hasClaimable([other], stats, {} as SaveData['achievements'])).toBe(false);
    expect(hasClaimable([other, def], stats, {} as SaveData['achievements'])).toBe(true);
  });

  it('reports reached tiers from an absent stats block as an empty set', () => {
    expect(reachedTierKeys([def], undefined as unknown as SaveData['stats']).size).toBe(0);
    expect([...reachedTierKeys([def], { 'kill.total': 100 } as SaveData['stats'])]).toEqual([
      'kills#1',
      'kills#2',
    ]);
  });
});

// ── campaignRewards' score denominators ─────────────────────────────────────────────────────

describe('star score with degenerate denominators', () => {
  function ctx(over: Partial<StarContext> = {}): StarContext {
    return {
      objectiveKind: 'destroy_base',
      remainingHpPct: 100,
      elapsedTicks: 100,
      floorTicks: 100,
      parTicks: 100,
      enemyLeaks: 0,
      leakBudget: 1,
      escortHpPct: null,
      unitsKilled: 0,
      totalEnemies: 1,
      ...over,
    } as StarContext;
  }

  it('awards a full speed score when par equals the floor (no room to be fast in)', () => {
    // par === floor means the level has no speed window at all; the alternative is a 0/0 division
    // that renders as NaN stars.
    const score = computeStarScore(ctx({ parTicks: 100, floorTicks: 100, elapsedTicks: 9_999 }));
    expect(Number.isFinite(score)).toBe(true);
    expect(computeStars([0, 0, 0], ctx({ parTicks: 100, floorTicks: 100 }))).toBeGreaterThan(0);
  });

  it('awards a full leak score when the level tracks no leak budget', () => {
    // Only leak_limit levels weigh the leak axis at all, so the comparison has to be made there.
    const leaky = { objectiveKind: 'leak_limit' as const };
    const withBudget = computeStarScore(ctx({ ...leaky, leakBudget: 4, enemyLeaks: 4 }));
    const noBudget = computeStarScore(ctx({ ...leaky, leakBudget: 0, enemyLeaks: 4 }));
    expect(noBudget).toBeGreaterThan(withBudget);
    expect(Number.isFinite(noBudget)).toBe(true);
  });

  it('awards a zero kill score when the level counts no enemies', () => {
    // 0/0 the other way: a level with nothing to kill scores 0 on that axis rather than NaN, so
    // the weight simply drops out of the total.
    const score = computeStarScore(ctx({ totalEnemies: 0, unitsKilled: 5 }));
    expect(Number.isFinite(score)).toBe(true);
  });
});

// ── teamTroops with stale references ────────────────────────────────────────────────────────

describe('team troop readouts with stale card references', () => {
  const army = [
    { cardInstanceId: 'alive', slot: 0 },
    { cardInstanceId: 'gone', slot: 1 },
    { cardInstanceId: undefined, slot: 2 },
  ] as never;

  it('counts a missing or empty army entry as zero, not as undefined troops', () => {
    // The readout is `carried/cap`; one NaN turns the whole label into "NaN/NaN" on the team list.
    const inv = { alive: card('alive', 'max', 3) };
    expect(Number.isFinite(teamTroopCap(army, inv))).toBe(true);
    expect(teamTroopCap(army, inv)).toBeGreaterThan(0);
    // carriedTroops reads the SLG per-card ledger, not the inventory: a stale id has no entry.
    const ledger = { alive: { currentTroops: 42 } } as unknown as Record<string, CardSLGState>;
    expect(carriedTroops(army, ledger)).toBe(42);
    expect(carriedTroops(army, undefined)).toBe(0);
  });

  it('reports zero for an absent army and an absent inventory', () => {
    expect(teamTroopCap(undefined, {})).toBe(0);
    expect(teamTroopCap(army, undefined)).toBe(0);
  });

  it('picks no leader when every army entry is stale, and the strongest card otherwise', () => {
    expect(teamLeaderCard(undefined, {})).toBeUndefined();
    expect(teamLeaderCard({ army, leaderCardId: undefined }, {})).toBeUndefined();

    const inv = { weak: card('weak', 'max', 1), strong: card('strong', 'max', 9) };
    const both = [{ cardInstanceId: 'weak', slot: 0 }, { cardInstanceId: 'strong', slot: 1 }] as never;
    expect(teamLeaderCard({ army: both, leaderCardId: undefined }, inv)?.id).toBe('strong');
  });

  it('ignores an explicit leader that is not actually in this army', () => {
    // A client-side edit can be a round trip ahead of the server; honouring a leader who has been
    // moved out of the team would show a portrait for a card that is not on it.
    const inv = { weak: card('weak', 'max', 1), elsewhere: card('elsewhere', 'max', 9) };
    const onlyWeak = [{ cardInstanceId: 'weak', slot: 0 }] as never;
    expect(teamLeaderCard({ army: onlyWeak, leaderCardId: 'elsewhere' }, inv)?.id).toBe('weak');
    expect(teamLeaderCard({ army: onlyWeak, leaderCardId: 'weak' }, inv)?.id).toBe('weak');
  });
});

// ── titles from unknown seasons ─────────────────────────────────────────────────────────────

describe('title ids this build does not know', () => {
  it('weighs a static title from the table and a dynamic season title from its rank', () => {
    expect(titleWeight('ach.pvp.veteran')).toBe(4200);
    expect(titleWeight('ladder.s3.gold')).toBeGreaterThan(0);
    expect(titleWeight('slg.s2.champion')).toBeGreaterThan(0);
  });

  it('weighs an unrecognised rank / an unparseable id as 0 rather than NaN', () => {
    // Titles are sorted by weight to pick which one to display; NaN would make that pick random.
    expect(titleWeight('ladder.s3.diamond_plus')).toBe(0);
    expect(titleWeight('something.else')).toBe(0);
    expect(titleWeight('')).toBe(0);
  });

  it('has no i18n keys for an unrecognised title, rather than inventing a missing key', () => {
    expect(getTitleKeys('ach.pvp.veteran')).not.toBeNull();
    expect(getTitleKeys('ladder.s9.gold')).toEqual({ fullKey: 'title.ladder.full', shortKey: 'title.ladder.short' });
    expect(getTitleKeys('slg.s9.champion')).toEqual({
      fullKey: 'title.slg.champion.full',
      shortKey: 'title.slg.champion.short',
    });
    expect(getTitleKeys('who.knows')).toBeNull();
  });

  it('echoes an unparseable ladder title back instead of formatting nonsense', () => {
    expect(formatLadderTitle('ladder.s4.plat')).toBe('S4 plat');
    expect(formatLadderTitle('ach.pvp.veteran')).toBe('ach.pvp.veteran');
  });
});

// ── migrate against odd version fields ──────────────────────────────────────────────────────

describe('migrate', () => {
  it('treats a non-numeric version as version 0 and still lands on the current schema', () => {
    const migrated = migrate({ version: 'v3', materials: { scrap: 7 } });
    expect(typeof migrated.version).toBe('number');
    expect(migrated.materials.scrap).toBe(7);
  });

  it('stops migrating when a step for the current version is missing and backfills instead', () => {
    // A save from a rollback (version higher than any step, or a gap) must still come out usable;
    // the alternative is an infinite while loop or a throw at startup.
    const future = migrate({ version: 999 });
    expect(typeof future.version).toBe('number');
    expect(future.progress).toBeDefined();
  });

  it('makes a fresh save from junk input', () => {
    for (const bad of [null, undefined, 42, 'x']) {
      expect(migrate(bad).progress.cleared, String(bad)).toEqual([]);
    }
  });
});

// ── small self-describing helpers ───────────────────────────────────────────────────────────

describe('affixKind', () => {
  it('classifies each id prefix and falls back to unknown', () => {
    expect(affixKind('m_atk')).toBe('main');
    expect(affixKind('s_critmult')).toBe('sub');
    expect(affixKind('k_firstblade')).toBe('skill');
    expect(affixKind('x_from_the_future')).toBe('unknown');
  });
});

describe('validatePvpDeck', () => {
  it('rejects a deck with no spell card, after the building check passes', () => {
    // The two class floors are separate messages on purpose: "you need a building" and "you need
    // a spell" are different fixes, and a deck can satisfy one and not the other. Only the
    // spell branch was unreached.
    const base = [...PVP_BASE_CARDS];
    const building = base.find((c) => PVP_BUILDING_CARDS.includes(c))!;
    const spell = base.find((c) => PVP_SPELL_CARDS.includes(c))!;
    const plain = base.filter((c) => c !== building && c !== spell);

    expect(validatePvpDeckClient([...plain, building], 1000)).not.toBeNull();
    expect(validatePvpDeckClient([...plain, spell], 1000)).not.toBeNull();
    expect(validatePvpDeckClient([...plain, building, spell], 1000)).toBeNull();
  });
});

describe('ReplayStore metadata', () => {
  function store(): ReplayStore {
    const map = new Map<string, string>();
    const storage: IStorage = {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    };
    return new ReplayStore(storage);
  }

  it('records levelId / winner only when the replay carries them', () => {
    // The list screen renders the winner chip from this entry; a stored `winner: undefined` and an
    // absent key look the same in JSON but not to `'winner' in entry`.
    const s = store();
    const bare = { mode: 'pvp', seed: 1, frames: [], endFrame: 0, meta: { recordedAt: 1 } } as unknown as Replay;
    const full = {
      mode: 'campaign', seed: 1, frames: [], endFrame: 0,
      meta: { recordedAt: 2, winner: 0, levelId: 'ch1_lv1' },
    } as unknown as Replay;
    s.save(bare, 1);
    s.save(full, 2);
    const list = s.list();
    const bareEntry = list.find((e) => e.recordedAt === 1)!;
    const fullEntry = list.find((e) => e.recordedAt === 2)!;
    expect('winner' in bareEntry).toBe(false);
    expect('levelId' in bareEntry).toBe(false);
    expect(fullEntry).toMatchObject({ winner: 0, levelId: 'ch1_lv1' });
  });
});

// ── campaign progress ───────────────────────────────────────────────────────────────────────

describe('campaign progress with unparseable ids', () => {
  it('parses a well-formed level id and rejects everything else', () => {
    expect(parseLevelId('ch3_lv7')).toEqual({ chapter: 3, lvIndex: 7 });
    for (const bad of ['ch3lv7', 'chX_lv1', 'ch1_lv', 'tutorial', '']) {
      expect(parseLevelId(bad), bad).toBeNull();
    }
  });

  it('unlocks the first level unconditionally and an unknown id as well', () => {
    const cleared = new Set<string>();
    expect(isLevelUnlocked('ch1_lv1', cleared)).toBe(true);
    // An id not in the order list yields index -1 → treated as unlocked rather than as a locked
    // node the player can never open.
    expect(isLevelUnlocked('ch9_lv9', cleared)).toBe(true);
  });

  it('reports the first-chapter gate as closed until every ch1 level is cleared', () => {
    expect(isFirstChapterCleared(new Set())).toBe(false);
  });

  it('falls back to the first chapter when the first uncleared level id is unparseable', () => {
    // Reached if the level order ever carries an id outside the chN_lvM convention: the book has
    // to open somewhere, and `undefined` would index the chapter map with undefined.
    expect(currentChapter(new Set())).toBe(CHAPTER_ORDER[0]);
  });

  it('returns null for a chapter with no map at all', () => {
    expect(currentLevelIdInChapter(999, new Set())).toBeNull();
    expect(currentLevelIdInChapter(1, new Set())).not.toBeNull();
  });
});
