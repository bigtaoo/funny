/**
 * `app/matchEngine.ts` — `createLocalMatch`'s option plumbing.
 *
 * 55% branch, the lowest in the client: `pvp-ai-deck-gate.test.ts` drives the PvP-with-decks path
 * and the E2E harness drives the campaign path, but the factory is almost entirely made of
 * conditional spreads and every one of them decides whether an option reaches the engine at all.
 *
 * A dropped spread here is silent by construction: the engine has a default for each of these, so
 * the match still runs — just without the card levels, the gear, the deck restriction or the AI
 * difficulty the caller asked for. That is exactly the shape of the bug `pvp-ai-deck-gate` was
 * written for (a missing `decks` leaked ELO-locked cards into a bot fallback), and the same
 * omission on `cardInstances`/`equipmentInv` would silently strip a player's progression out of
 * their own PvE run.
 */
import { describe, it, expect } from 'vitest';
import { createLocalMatch } from '../src/app/matchEngine';
import type { LevelDefinition } from '@nw/engine';
import type { EngineCardInstance, EngineEquipInv } from '@nw/engine';

function level(over: Partial<LevelDefinition> = {}): LevelDefinition {
  return {
    id: 'ch1_test',
    chapter: 1,
    seed: 4242,
    objective: { kind: 'survive' },
    waves: { entries: [{ atTick: 30, unitType: 'infantry', col: 0, count: 1 }] },
    ...over,
  } as LevelDefinition;
}

const CARDS: EngineCardInstance[] = [
  { id: 'c1', defId: 'infantry', unitType: 'infantry' as never, level: 9, gear: { weapon: 'e1' } },
];
const GEAR: EngineEquipInv = {
  e1: { defId: 'w_sword', level: 9, affixes: [{ id: 'm_atk', value: 20 }] },
};

describe('seed and mode selection', () => {
  it('takes the seed from the level and mode campaign when a level is given', () => {
    const { buildReplay } = createLocalMatch({ level: level({ seed: 777 }) });
    const replay = buildReplay(0);
    expect(replay.seed).toBe(777);
    expect(replay.mode).toBe('campaign');
    expect(replay.configRef).toBe('ch1_test');
    expect(replay.meta?.levelId).toBe('ch1_test');
  });

  it('ignores an explicit seed when a level is present — the level owns it', () => {
    // Otherwise a caller-supplied seed would desync the recompute: the judge derives the seed
    // from its own copy of the level, not from the replay.
    const { buildReplay } = createLocalMatch({ level: level({ seed: 777 }), seed: 1 });
    expect(buildReplay(0).seed).toBe(777);
  });

  it('uses the explicit seed and mode pvp with no level', () => {
    const { buildReplay } = createLocalMatch({ seed: 0x1234 });
    const replay = buildReplay(1);
    expect(replay.seed).toBe(0x1234);
    expect(replay.mode).toBe('pvp');
    // No level → no configRef and no levelId on the replay at all.
    expect('configRef' in replay).toBe(false);
    expect(replay.meta && 'levelId' in replay.meta).toBe(false);
  });

  it('coerces an explicit seed to a uint32', () => {
    // The random fallback is `Date.now() ^ …` and can exceed 32 bits; the engine's PRNG and the
    // server's copy of the seed have to agree, so the >>> 0 applies to both paths.
    expect(createLocalMatch({ seed: -1 }).buildReplay(null).seed).toBe(0xffffffff);
    expect(createLocalMatch({ seed: 2 ** 32 + 5 }).buildReplay(null).seed).toBe(5);
  });

  it('invents a seed when none is given, and two matches do not share it', () => {
    const a = createLocalMatch().buildReplay(null).seed;
    const b = createLocalMatch().buildReplay(null).seed;
    expect(Number.isInteger(a)).toBe(true);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(0xffffffff);
    expect(a).not.toBe(b);
  });

  it('honours an explicit mode override, including siege over a level', () => {
    expect(createLocalMatch({ level: level(), mode: 'siege' }).buildReplay(0).mode).toBe('siege');
    expect(createLocalMatch({ seed: 1, mode: 'netplay' }).buildReplay(0).mode).toBe('netplay');
  });
});

describe('PvE option plumbing', () => {
  it('reaches the engine with the card levels and gear, and without them when omitted', () => {
    // The observable difference: a level-9 card with a +20% attack weapon produces a stronger
    // blueprint than the bare L1 table. If either spread were dropped, this factory would
    // silently hand the player an unbuffed run.
    const buffed = createLocalMatch({ level: level(), cardInstances: CARDS, equipmentInv: GEAR });
    const cardsOnly = createLocalMatch({ level: level(), cardInstances: CARDS });
    const bare = createLocalMatch({ level: level() });

    const atk = (m: ReturnType<typeof createLocalMatch>): number =>
      m.engine.state.unitBlueprints.infantry.attack_fp;

    expect(atk(cardsOnly)).toBeGreaterThan(atk(bare));
    expect(atk(buffed)).toBeGreaterThan(atk(cardsOnly));
  });

  it('ignores equipmentInv with no cardInstances — gear is resolved per card', () => {
    const gearOnly = createLocalMatch({ level: level(), equipmentInv: GEAR });
    const bare = createLocalMatch({ level: level() });
    expect(gearOnly.engine.state.unitBlueprints.infantry.attack_fp).toBe(
      bare.engine.state.unitBlueprints.infantry.attack_fp,
    );
  });
});

describe('PvP option plumbing', () => {
  it('restricts the draw pools when decks are given and not when they are omitted', () => {
    const deck = { top: ['infantry_1'], bottom: ['infantry_1'] };
    const gated = createLocalMatch({ seed: 9, decks: deck });
    for (let i = 0; i < 50; i++) {
      expect(gated.engine.state.bottomPlayer.drawPolicy.draw().id).toBe('infantry_1');
    }

    const open = createLocalMatch({ seed: 9 });
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(open.engine.state.topPlayer.drawPolicy.draw().id);
    expect(ids.size).toBeGreaterThan(1);
  });

  it('records the decks on the replay so a recompute rebuilds the same restriction', () => {
    const deck = { top: ['infantry_1'], bottom: ['archer_1'] };
    expect(createLocalMatch({ seed: 9, decks: deck }).buildReplay(0).decks).toEqual(deck);
    expect('decks' in createLocalMatch({ seed: 9 }).buildReplay(0)).toBe(false);
  });

  it('ignores decks on the PvE path (the level owns the loadout) but still records them', () => {
    // The engine config spread puts `decks` behind the `level` check, while the REPLAY spread does
    // not — so a campaign replay carries the field even though the run ignored it. Pinned as-is:
    // the replay is descriptive, and a recompute of a campaign replay reads the level, not decks.
    const deck = { top: ['infantry_1'], bottom: ['infantry_1'] };
    const m = createLocalMatch({ level: level(), decks: deck });
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(m.engine.state.bottomPlayer.drawPolicy.draw().id);
    expect(ids.size).toBeGreaterThan(1);
    expect(m.buildReplay(0).decks).toEqual(deck);
  });

  it('passes an explicit AI difficulty through, including the falsy-looking level 1', () => {
    // The engine keeps the difficulty inside AISystem rather than on state, so the observable
    // proof is that the same seed simulates DIFFERENTLY: level 1 thinks every 75 ticks, level 10
    // every 12. The guard is `difficulty !== undefined`, not a truthiness check — difficulty 1 is
    // the easiest AI, not "none given", and a truthy guard would silently upgrade it to 5.
    const run = (difficulty?: 1 | 10): string => {
      const { engine } = createLocalMatch(difficulty === undefined ? { seed: 7 } : { seed: 7, difficulty });
      for (let t = 0; t < 900; t++) engine.tick(1 / 30);
      return JSON.stringify(engine.state.snapshotStats());
    };
    const easiest = run(1);
    const hardest = run(10);
    const defaulted = run();
    expect(easiest).not.toBe(hardest);
    expect(easiest).not.toBe(defaulted);
    // Determinism check, so the inequalities above cannot pass for the wrong reason.
    expect(run(1)).toBe(easiest);
  }, 30_000);
});

describe('replay metadata', () => {
  it('records the winner, and -1 for a draw', () => {
    const m = createLocalMatch({ seed: 1 });
    expect(m.buildReplay(0).meta?.winner).toBe(0);
    expect(m.buildReplay(1).meta?.winner).toBe(1);
    // The replay format has no null; a draw is -1, which the replay player renders as "draw".
    expect(m.buildReplay(null).meta?.winner).toBe(-1);
  });

  it('records player names when given and leaves the field off when not', () => {
    const named = createLocalMatch({ seed: 1, players: { bottom: 'Tao', top: 'Anna' } });
    expect(named.buildReplay(0).meta?.players).toEqual({ bottom: 'Tao', top: 'Anna' });
    // Absent → the replay player falls back to its own placeholder rather than showing "undefined".
    const anon = createLocalMatch({ seed: 1 });
    expect(anon.buildReplay(0).meta && 'players' in anon.buildReplay(0).meta!).toBe(false);
    // A one-sided name is carried through as-is (the player fills in the other side).
    const half = createLocalMatch({ seed: 1, players: { bottom: 'Tao' } });
    expect(half.buildReplay(0).meta?.players).toEqual({ bottom: 'Tao' });
  });

  it('records the commands the local player actually issued', () => {
    // The recorder wraps LocalInputSource, so what lands in the replay is the confirmed stream —
    // this is what makes a local run reproducible by the judge.
    const { engine, buildReplay } = createLocalMatch({ seed: 0x2222 });
    engine.tick(1 / 30);
    engine.upgradeBase();
    engine.tick(1 / 30);
    const replay = buildReplay(0);
    expect(replay.frames.some((f) => f.commands.some((c) => c.type === 'upgrade_base'))).toBe(true);
    expect(replay.endFrame).toBeGreaterThan(0);
  });
});
