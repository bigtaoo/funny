// SLG siege engine + judgeRunner re-verification (S8-3, SLG_DESIGN §5).
//
// Siege mode = campaign mechanics (defender WaveDirector script) + buildSiegeBlueprints
// progression blueprints; attacker = local player (owner 0), destroying the defender base
// = attacker_win captures the tile. This test covers three areas:
//   ① Progression monotonicity + ladder red-line (§6): siege blueprints strengthen with
//      upgrades, {} equals the constant baseline, PvP blueprints are never affected.
//   ② Engine determinism: same seed + same defense config + same attacker command stream
//      → identical game-over outcome verbatim.
//   ③ Judge re-verification closed loop: record a siege run → encode upload frames →
//      JudgeRequest(defenseJson) → runJudge re-computes the same winner.
import { describe, it, expect } from 'vitest';
import { createGameEngine } from '../src/game/GameEngine';
import { RecordingInputSource } from '../src/game/net/ReplayInputSource';
import { LocalInputSource } from '../src/game/net/InputSource';
import { Side, GamePhase, UnitType } from '../src/game/types';
import type { GameConfig, IGameEngine, OwnerId } from '../src/game/types';
import type { LevelDefinition } from '../src/game/campaign/LevelDefinition';
import { UNIT_BLUEPRINTS } from '../src/game/config';
import { pvpExpectedBlueprints } from './pvpBlueprintExpected';
import {
  buildPvpBlueprints,
  buildSiegeBlueprints,
} from '../src/game/balance/pveUpgrades';
import { UNIT_MAX_LEVEL } from '../src/game/balance/progression';
import { cardsAtLevel } from './cardHelpers';
import { runJudge } from '../src/net/judgeRunner';
import { replayToUploadFrames } from '../src/net/replayUpload';
import type { JudgeRequest, FrameCmds } from '../src/net/proto/transport';

const TICK_DT = 1 / 30;
const GameOver = GamePhase.GameOver;

/** A defense config suitable for a siege (worldsvc S8-3 constructs the same shape on-the-fly for an attacked tile). */
function defenseConfig(seed: number): LevelDefinition {
  return {
    id: 'siege_test',
    chapter: 0,
    seed,
    objective: { kind: 'timed_defense', durationTicks: 300 },
    waves: {
      entries: [
        { atTick: 30, unitType: UnitType.Infantry, col: 4, count: 3, spacingTicks: 20 },
        { atTick: 90, unitType: UnitType.Archer, col: 7, count: 2, spacingTicks: 15 },
      ],
    },
  };
}

type PlayScript = { plays: Record<number, [number, number]>; upgrades?: number[] };

function driveToEnd(engine: IGameEngine, maxTicks: number, script: PlayScript): number {
  const upgrades = new Set(script.upgrades ?? []);
  let i = 0;
  for (; i < maxTicks && engine.state.phase !== GameOver; i++) {
    const play = script.plays[i];
    if (play) engine.playCard(play[0], play[1]);
    if (upgrades.has(i)) engine.upgradeBase();
    engine.tick(TICK_DT);
  }
  return i;
}

function winnerOf(engine: IGameEngine): OwnerId | null {
  const w = engine.state.winner;
  return w === Side.Top ? 1 : w === Side.Bottom ? 0 : null;
}

/** Upload frames (base64) → JudgeRequest frames (bytes), simulating gateway's decodeFrames. */
function toJudgeFrames(upload: ReturnType<typeof replayToUploadFrames>): FrameCmds[] {
  return upload.map((f) => ({
    frame: f.frame,
    cmds: f.cmds.map((c) => ({
      side: c.side,
      commands: new Uint8Array(Buffer.from(c.commands, 'base64')),
    })),
  }));
}

describe('siege progression blueprints — monotonicity + ladder red-line (SLG7 §6)', () => {
  it('buildSiegeBlueprints([]) equals the constant baseline', () => {
    expect(buildSiegeBlueprints([])).toEqual(UNIT_BLUEPRINTS);
  });

  it('higher progression → stronger siege blueprints (HP / attack)', () => {
    const sg = buildSiegeBlueprints(cardsAtLevel(UNIT_MAX_LEVEL));
    expect(sg[UnitType.Infantry].hp).toBeGreaterThan(UNIT_BLUEPRINTS[UnitType.Infantry].hp);
    expect(sg[UnitType.Archer].attack).toBeGreaterThan(UNIT_BLUEPRINTS[UnitType.Archer].attack);
  });

  it('after maxed siege blueprints, PvP blueprints still equal the constant baseline (+ static §5 override; red-line intact)', () => {
    void buildSiegeBlueprints(cardsAtLevel(UNIT_MAX_LEVEL));
    expect(buildPvpBlueprints()).toEqual(pvpExpectedBlueprints());
  });

  it('siege engine uses buildSiegeBlueprints; progression takes effect under the same mode', () => {
    const lvl = defenseConfig(1);
    const eng = createGameEngine(
      { seed: 1, players: [{ id: 0 }, { id: 1 }], mode: 'siege', level: lvl, cardInstances: cardsAtLevel(UNIT_MAX_LEVEL) },
    ) as unknown as { state: { unitBlueprints: typeof UNIT_BLUEPRINTS } };
    expect(eng.state.unitBlueprints[UnitType.Infantry].hp).toBeGreaterThan(
      UNIT_BLUEPRINTS[UnitType.Infantry].hp,
    );
  });
});

describe('siege engine determinism', () => {
  it('same seed + same defense config + same attacker commands → same game-over winner', () => {
    const SEED = 0x51e6e;
    const lvl = defenseConfig(SEED);
    const cfg: GameConfig = { seed: SEED, players: [{ id: 0 }, { id: 1 }], mode: 'siege', level: lvl };
    const script: PlayScript = { plays: { 20: [0, 4], 80: [0, 7], 150: [1, 4] }, upgrades: [40] };

    const a = createGameEngine(cfg);
    driveToEnd(a, 6000, script);
    const b = createGameEngine(cfg);
    driveToEnd(b, 6000, script);

    expect(a.state.phase).toBe(GameOver);
    expect(b.state.phase).toBe(GameOver);
    expect(winnerOf(a)).toBe(winnerOf(b));
    expect(a.state.snapshotStats()).toEqual(b.state.snapshotStats());
  });
});

describe('judgeRunner — siege re-verification closed loop', () => {
  it('re-verified winner matches the original game-over outcome (record→encode→decode→siege re-run)', () => {
    const SEED = 0xc0ffee;
    const lvl = defenseConfig(SEED);
    const cfg: GameConfig = { seed: SEED, players: [{ id: 0 }, { id: 1 }], mode: 'siege', level: lvl };
    const script: PlayScript = { plays: { 25: [0, 4], 70: [0, 7], 140: [1, 4], 200: [2, 8] }, upgrades: [50] };

    const rec = new RecordingInputSource(new LocalInputSource());
    const original = createGameEngine(cfg, rec);
    const ran = driveToEnd(original, 6000, script);
    expect(original.state.phase).toBe(GameOver);
    const expectedWinner = winnerOf(original);
    const replay = rec.snapshot({ seed: SEED, mode: 'siege', configRef: lvl.id });

    const frames = toJudgeFrames(replayToUploadFrames(replay));
    // PvE/SLG replays contain only attacker (owner 0) commands (the defender WaveDirector is re-derived from seed+config).
    for (const f of frames) for (const c of f.cmds) expect(c.side).toBe(0);

    const req: JudgeRequest = {
      requestId: 'siege-test',
      seed: SEED,
      mode: 0,
      endFrame: replay.endFrame,
      frames,
      levelId: '',
      pveUpgrades: {},
      unitLevels: {},
      defenseJson: JSON.stringify(lvl),
      topDeck: [],
      bottomDeck: [],
    };

    const out = runJudge(req);
    expect(out.ok).toBe(true);
    expect(out.winnerSide).toBe(expectedWinner ?? 1);
    expect(ran).toBeGreaterThan(0);
  });

  it('invalid defenseJson → re-verification fails', () => {
    const req: JudgeRequest = {
      requestId: 'bad',
      seed: 1,
      mode: 0,
      endFrame: 10,
      frames: [],
      levelId: '',
      pveUpgrades: {},
      unitLevels: {},
      defenseJson: '{not json',
      topDeck: [],
      bottomDeck: [],
    };
    expect(runJudge(req)).toEqual({ ok: false, stateHash: '', winnerSide: 0, stars: 0, statsJson: '' });
  });
});
