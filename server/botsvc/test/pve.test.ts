// BOTSVC_DESIGN §3.5: a bot's PvE run against the real engine and the real level JSON. The contract
// that matters is the spot check: a peer judge rebuilds the run from the level's seed, the server's
// copy of the bot's cards and the uploaded frames (client/src/net/judgeRunner.ts runPveJudge), and an
// honest bot must get back exactly the stars it claimed — or the server files an ops ticket.
import { describe, it, expect } from 'vitest';
import {
  CAMPAIGN_LEVEL_ORDER,
  ENGINE_VERSION,
  ReplayInputSource,
  Side,
  buildStarContext,
  computeStars,
  getLevel,
  runHeadless,
  type EngineCardInstance,
  type LevelDefinition,
} from '@nw/engine';
import { PVE_LEVELS } from '@nw/shared';
import { PVE_REPLAY_CHANCE, pickLevel, playLevel, toEngineCards, type PveRunResult } from '../src/pve';
import { decodeSideCommands } from '../src/protoCodec';

const NO_CARDS = { cardInstances: [] as EngineCardInstance[], equipmentInv: {} };

/** runPveJudge, minus the proto transport: the stars a judge recomputes from what the bot uploaded. */
function judgeStars(level: LevelDefinition, run: PveRunResult, cards = NO_CARDS): number {
  const frames = run.frames.map((f) => ({
    tick: f.frame,
    commands: f.cmds.flatMap((c) => decodeSideCommands(Buffer.from(c.commands, 'base64'), c.side as 0 | 1, f.frame)),
  }));
  const replay = { engineVersion: ENGINE_VERSION, mode: 'campaign' as const, seed: level.seed, frames, endFrame: run.endFrame };
  const { engine } = runHeadless(
    { seed: level.seed, players: [{ id: 0 }, { id: 1 }], mode: 'campaign', level, ...cards },
    new ReplayInputSource(replay),
    run.endFrame + 600,
  );
  if (engine.state.winner !== Side.Bottom) return 0;
  const stats = engine.state.snapshotStats();
  const summary = engine.state.snapshotSummary();
  return computeStars(level.rewards?.starThresholds, buildStarContext(level, {
    damageTakenByBase: stats[0].damageTakenByBase,
    elapsedTicks: summary.elapsedTicks,
    enemyLeaks: summary.enemyLeaks,
    escortMinHpPct: summary.escortMinHpPct,
    unitsKilled: stats[0].unitsKilled,
  }));
}

describe('playLevel — the spot check an honest bot must pass', () => {
  it('the judge recomputes exactly the claimed stars, on every campaign level, won or lost', async () => {
    let won = 0;
    for (const id of CAMPAIGN_LEVEL_ORDER) {
      const level = getLevel(id)!;
      const run = await playLevel(level, NO_CARDS, { aiSeed: 7, difficulty: 8 });
      expect(judgeStars(level, run), id).toBe(run.stars);
      if (run.won) won++;
    }
    // Not a balance target — proof the runs are real games, some won and some lost.
    expect(won).toBeGreaterThan(0);
    expect(won).toBeLessThan(CAMPAIGN_LEVEL_ORDER.length);
  }, 120_000);

  it('with cards: the same snapshot on both sides reproduces the run', async () => {
    const level = getLevel('ch1_lv3')!;
    const cards = {
      cardInstances: toEngineCards({ c1: { id: 'c1', defId: 'lichuang', level: 9, xp: 0, gear: {} } as any }),
      equipmentInv: {},
    };
    const run = await playLevel(level, cards, { aiSeed: 3, difficulty: 8 });
    expect(judgeStars(level, run, cards)).toBe(run.stars);
  });

  it('a win carries 1..3 stars and the achievement stats; a loss neither', async () => {
    const runs = await Promise.all(
      CAMPAIGN_LEVEL_ORDER.slice(0, 12).map((id) => playLevel(getLevel(id)!, NO_CARDS, { aiSeed: 7, difficulty: 8 })),
    );
    for (const r of runs) {
      if (r.won) {
        expect(r.stars).toBeGreaterThanOrEqual(1);
        expect(r.stars).toBeLessThanOrEqual(3);
      } else {
        expect(r.stars).toBe(0);
        expect(r.stats).toEqual({});
      }
    }
    expect(runs.some((r) => r.won)).toBe(true);
    // Stats only list what happened (a quiet win can have none), but some win has them.
    expect(runs.some((r) => r.won && Object.keys(r.stats).length > 0)).toBe(true);
  }, 60_000);

  it('frames: only the player\'s side, ascending, all before endFrame', async () => {
    const run = await playLevel(getLevel('ch1_lv1')!, NO_CARDS, { aiSeed: 7 });
    expect(run.frames.length).toBeGreaterThan(0);
    for (let i = 0; i < run.frames.length; i++) {
      const f = run.frames[i]!;
      expect(f.cmds.map((c) => c.side)).toEqual([0]);
      expect(f.frame).toBeLessThan(run.endFrame);
      if (i > 0) expect(f.frame).toBeGreaterThan(run.frames[i - 1]!.frame);
    }
  });

  it('chunking the loop across macrotasks changes nothing', async () => {
    const level = getLevel('ch1_lv2')!;
    const a = await playLevel(level, NO_CARDS, { aiSeed: 11, chunkFrames: 7 });
    const b = await playLevel(level, NO_CARDS, { aiSeed: 11, chunkFrames: 100_000 });
    expect(a).toEqual(b);
  });

  it('the bot\'s own seed changes its play, not the level', async () => {
    const level = getLevel('ch1_lv1')!;
    const a = await playLevel(level, NO_CARDS, { aiSeed: 1 });
    const b = await playLevel(level, NO_CARDS, { aiSeed: 2 });
    expect(a.frames).not.toEqual(b.frames);
  });

  it('past maxFrames it stops and counts as a loss', async () => {
    const run = await playLevel(getLevel('ch1_lv1')!, NO_CARDS, { aiSeed: 7, maxFrames: 100 });
    expect(run).toMatchObject({ won: false, stars: 0, endFrame: 100 });
  });
});

describe('toEngineCards', () => {
  it('resolves unitType from the shared card catalogue and skips unknown cards', () => {
    expect(toEngineCards({
      a: { id: 'a', defId: 'suyuan', level: 2, xp: 0, gear: { weapon: 'e1' } } as any,
      b: { id: 'b', defId: 'no-such-card', level: 1, xp: 0, gear: {} } as any,
    })).toEqual([{ id: 'a', defId: 'suyuan', unitType: 'archer', level: 2, gear: { weapon: 'e1' } }]);
    expect(toEngineCards(null)).toEqual([]);
    expect(toEngineCards(undefined)).toEqual([]);
  });
});

describe('pickLevel', () => {
  const fresh = { cleared: [] as string[], stars: {} as Record<string, number> };
  const never = () => 0.99;
  const always = () => 0;

  it('a fresh bot enters the first level', () => {
    expect(pickLevel(fresh, always)).toBe('ch1_lv1');
  });

  it('the first uncleared level is always unlocked: each level requires exactly the one before it', () => {
    const requires = new Map(PVE_LEVELS.map((l) => [l.id, l.requires]));
    CAMPAIGN_LEVEL_ORDER.forEach((id, i) => expect(requires.get(id), id).toBe(i === 0 ? null : CAMPAIGN_LEVEL_ORDER[i - 1]));
  });

  it('the frontier is the first uncleared level', () => {
    expect(pickLevel({ cleared: ['ch1_lv1', 'ch1_lv2'], stars: { ch1_lv1: 3, ch1_lv2: 3 } }, never)).toBe('ch1_lv3');
  });

  it(`replays a cleared level short of 3 stars with PVE_REPLAY_CHANCE (${PVE_REPLAY_CHANCE})`, () => {
    const p = { cleared: ['ch1_lv1', 'ch1_lv2'], stars: { ch1_lv1: 3, ch1_lv2: 1 } };
    expect(pickLevel(p, () => PVE_REPLAY_CHANCE - 0.01)).toBe('ch1_lv2');
    expect(pickLevel(p, () => PVE_REPLAY_CHANCE)).toBe('ch1_lv3');
  });

  it('never replays a 3-star level', () => {
    expect(pickLevel({ cleared: ['ch1_lv1'], stars: { ch1_lv1: 3 } }, always)).toBe('ch1_lv2');
  });

  it('with the campaign all cleared, only replays; all 3-starred, nothing', () => {
    const all = CAMPAIGN_LEVEL_ORDER.filter((id) => PVE_LEVELS.some((l) => l.id === id));
    const three = Object.fromEntries(all.map((id) => [id, 3]));
    expect(pickLevel({ cleared: all, stars: { ...three, ch2_lv4: 2 } }, never)).toBe('ch2_lv4');
    expect(pickLevel({ cleared: all, stars: three }, always)).toBeNull();
  });

  it('only levels the server settles: every pick is in the reward table and in the engine', () => {
    const ids = new Set(PVE_LEVELS.map((l) => l.id));
    const cleared: string[] = [];
    for (let i = 0; i < 80; i++) {
      const id = pickLevel({ cleared, stars: {} }, never);
      if (!id) break;
      expect(ids.has(id), id).toBe(true);
      expect(getLevel(id), id).not.toBeNull();
      cleared.push(id);
    }
    expect(cleared.length).toBeGreaterThanOrEqual(60);
  });
});
