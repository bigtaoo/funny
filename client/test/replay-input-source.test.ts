// ReplayInputSource + RecordingInputSource (S1-RP) — record & replay.
//
// Two layers of coverage:
//   1. Unit: take()/submit() semantics of both sources + version validation.
//   2. Integration: record a real run (PvP-vs-AI and PvE/campaign) through a
//      RecordingInputSource, then drive a fresh engine from the resulting Replay
//      via ReplayInputSource — assert the final state fingerprint is identical
//      (the recording reproduces the run byte-for-byte from seed + input stream).
import { describe, it, expect } from 'vitest';
import { createGameEngine } from '../src/game/GameEngine';
import {
  RecordingInputSource,
  ReplayInputSource,
  ReplayVersionError,
} from '../src/game/net/ReplayInputSource';
import { LocalInputSource, type InputSource } from '../src/game/net/InputSource';
import { ENGINE_VERSION } from '../src/game/types';
import type { GameConfig, IGameEngine, Replay } from '../src/game/types';
import { CAMPAIGN_LEVELS, CAMPAIGN_LEVEL_ORDER } from '../src/game/campaign/levels';

const TICK_DT = 1 / 30;

function pvpConfig(seed: number): GameConfig {
  return { seed, players: [{ id: 0 }, { id: 1 }] };
}

/** Deep-comparable fingerprint of the full game state (same shape across runs). */
function fingerprint(engine: IGameEngine): unknown {
  const s = engine.state;
  const units = Array.from(s.board.units.values())
    .map((u) => `${u.id}:${u.unitType}:${u.side}:${u.col}:${u.y_fp}:${u.x_fp}:${u.hp}:${u.state}`)
    .sort();
  const buildings = Array.from(s.board.buildings.values())
    .map((b) => `${b.id}:${b.buildingType}:${b.side}:${b.col}:${b.row}:${b.hp}`)
    .sort();
  return {
    elapsedTicks: s.elapsedTicks,
    phase: s.phase,
    winner: s.winner,
    bottomBaseHp: s.bottomPlayer.baseHp,
    topBaseHp: s.topPlayer.baseHp,
    bottomInk: s.bottomPlayer.ink,
    topInk: s.topPlayer.ink,
    units,
    buildings,
    stats: s.snapshotStats(),
  };
}

/** A scripted player: { tickToTap: [handIndex, col] } and a set of upgrade ticks. */
type PlayScript = { plays: Record<number, [number, number]>; upgrades?: number[] };

/** Run `ticks` of an engine, injecting the script's player commands at exact ticks. */
function drive(engine: IGameEngine, ticks: number, script: PlayScript): void {
  const upgrades = new Set(script.upgrades ?? []);
  for (let i = 0; i < ticks; i++) {
    // currentTick === i here (TICK_DT advances exactly one tick per call), so a
    // command submitted now lands on frame i.
    const play = script.plays[i];
    if (play) engine.playCard(play[0], play[1]);
    if (upgrades.has(i)) engine.upgradeBase();
    engine.tick(TICK_DT);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
describe('ReplayInputSource — take() / submit()', () => {
  const makeReplay = (frames: Replay['frames'], endFrame: number): Replay => ({
    engineVersion: ENGINE_VERSION,
    mode: 'pvp',
    seed: 1,
    frames,
    endFrame,
  });

  it('returns recorded commands on their frame, empty for sparse gaps, never null', () => {
    const rp = new ReplayInputSource(
      makeReplay(
        [{ tick: 5, commands: [{ type: 'play_card', owner: 0, tick: 5, handIndex: 2, col: 1 }] }],
        10,
      ),
    );
    expect(rp.take(0)).toEqual([]);
    expect(rp.take(4)).toEqual([]);
    expect(rp.take(5)).toEqual([
      { type: 'play_card', owner: 0, tick: 5, handIndex: 2, col: 1 },
    ]);
    expect(rp.take(6)).toEqual([]); // gap → empty, not null
    expect(rp.take(99)).toEqual([]); // past the end → still empty (engine ends via game_over)
  });

  it('ignores submit() — playback is fixed', () => {
    const rp = new ReplayInputSource(makeReplay([], 3));
    rp.submit({ type: 'upgrade_base', owner: 0, tick: 0 });
    expect(rp.take(0)).toEqual([]);
  });

  it('exposes endFrame and isComplete()', () => {
    const rp = new ReplayInputSource(makeReplay([], 7));
    expect(rp.endFrame).toBe(7);
    expect(rp.isComplete(6)).toBe(false);
    expect(rp.isComplete(7)).toBe(true);
  });

  it('throws ReplayVersionError on an engineVersion mismatch', () => {
    const bad = { ...makeReplay([], 3), engineVersion: ENGINE_VERSION + 1 };
    expect(() => new ReplayInputSource(bad)).toThrow(ReplayVersionError);
    // …unless validation is disabled.
    expect(() => new ReplayInputSource(bad, false)).not.toThrow();
  });
});

describe('RecordingInputSource — capture', () => {
  it('is transparent: submit/take delegate to the inner source', () => {
    const inner = new LocalInputSource();
    const rec = new RecordingInputSource(inner);
    rec.submit({ type: 'play_card', owner: 0, tick: 0, handIndex: 1, col: 2 });
    // take pulls the inner queue exactly as LocalInputSource would.
    expect(rec.take(0)).toEqual([
      { type: 'play_card', owner: 0, tick: 0, handIndex: 1, col: 2 },
    ]);
    expect(rec.take(1)).toEqual([]); // queue drained
  });

  it('records only non-empty confirmed sets, sparse and ascending', () => {
    const rec = new RecordingInputSource(new LocalInputSource());
    rec.take(0); // empty — not recorded
    rec.submit({ type: 'upgrade_base', owner: 0, tick: 1 });
    rec.take(1); // recorded at frame 1
    rec.take(2); // empty
    rec.submit({ type: 'play_card', owner: 0, tick: 3, handIndex: 0, col: 4 });
    rec.take(3); // recorded at frame 3

    const replay = rec.snapshot({ seed: 99, mode: 'campaign', configRef: 'lvl-x' });
    expect(replay.engineVersion).toBe(ENGINE_VERSION);
    expect(replay.seed).toBe(99);
    expect(replay.mode).toBe('campaign');
    expect(replay.configRef).toBe('lvl-x');
    expect(replay.endFrame).toBe(4); // last executed frame (3) + 1
    expect(replay.frames).toEqual([
      { tick: 1, commands: [{ type: 'upgrade_base', owner: 0, tick: 1 }] },
      { tick: 3, commands: [{ type: 'play_card', owner: 0, tick: 3, handIndex: 0, col: 4 }] },
    ]);
  });

  it('forwards confirmedLead so the engine catch-up ladder still sees the net backlog', () => {
    // Regression: nav/result.ts wraps the live NetInputSource in a RecordingInputSource,
    // so if the recorder drops confirmedLead the engine reads 0 and catch-up is pinned at
    // 1× for the whole online match — a backgrounded-tab hitch then never drains.
    const inner: InputSource = {
      submit() {},
      take: () => [],
      confirmedLead: (frame) => 900 - frame, // 30 s backlog at 30 Hz, shrinking toward the head
    };
    const rec = new RecordingInputSource(inner);
    expect(rec.confirmedLead(0)).toBe(900);
    expect(rec.confirmedLead(900)).toBe(0);
  });

  it('reports 0 lead when the inner source has no confirmedLead (LocalInputSource → always 1×)', () => {
    const rec = new RecordingInputSource(new LocalInputSource());
    expect(rec.confirmedLead(0)).toBe(0);
  });

  it('deep-clones captured commands (later mutation cannot corrupt the recording)', () => {
    const rec = new RecordingInputSource(new LocalInputSource());
    const cmd = { type: 'play_card' as const, owner: 0 as const, tick: 0, handIndex: 0, col: 1 };
    rec.submit(cmd);
    rec.take(0);
    cmd.col = 999; // mutate the live object after capture
    const replay = rec.snapshot({ seed: 1, mode: 'pvp' });
    expect(replay.frames[0]!.commands[0]).toMatchObject({ col: 1 });
  });

  it('carries decks through snapshot() when provided, omits the key when not', () => {
    const rec = new RecordingInputSource(new LocalInputSource());
    const decks = { top: ['infantry_2', 'archer_2'], bottom: ['infantry_1', 'archer_1', 'tower_1'] };
    const withDecks = rec.snapshot({ seed: 1, mode: 'pvp', decks });
    expect(withDecks.decks).toEqual(decks);

    const withoutDecks = rec.snapshot({ seed: 1, mode: 'pvp' });
    expect(withoutDecks.decks).toBeUndefined();
  });
});

// ── decks (PVP_LOADOUT_DESIGN §6.2): record → replay must carry the deck loadout through ──────
//
// Regression coverage for the 2026-07-15 replay-share bug: a shared/watched replay's engine
// reconstruction (client/src/scenes/ReplayScene.ts) used to omit `decks`, so playback drew from
// the full CARD_DEFINITIONS pool and ELO-locked cards (runner/splitter/…) could appear in a
// replay of a match that never actually drew them.
describe('record → replay carries decks through (PVP_LOADOUT_DESIGN §6.2)', () => {
  const SEED = 42;
  const bottomDeck = ['infantry_1', 'archer_1', 'tower_1'];
  const topDeck = ['infantry_2', 'archer_2'];
  const decks = { bottom: bottomDeck, top: topDeck };

  function recordRestrictedMatch(): Replay {
    const rec = new RecordingInputSource(new LocalInputSource());
    const original = createGameEngine({ ...pvpConfig(SEED), decks }, rec);
    drive(original, 300, { plays: { 50: [0, 1] } });
    // JSON round-trip: exercises the same (de)serialisation a real share/fetch does.
    return JSON.parse(JSON.stringify(rec.snapshot({ seed: SEED, mode: 'pvp', decks })));
  }

  it('replay.decks matches what the match was recorded with', () => {
    const replay = recordRestrictedMatch();
    expect(replay.decks).toEqual(decks);
  });

  it('reconstructing the engine with replay.decks (as ReplayScene.ts now does) keeps draws within the recorded deck', () => {
    const replay = recordRestrictedMatch();
    const replayed = createGameEngine({ ...pvpConfig(SEED), decks: replay.decks }, new ReplayInputSource(replay));

    for (let i = 0; i < 100; i++) {
      expect(bottomDeck).toContain(replayed.state.bottomPlayer.drawPolicy.draw().id);
    }
    for (let i = 0; i < 100; i++) {
      expect(topDeck).toContain(replayed.state.topPlayer.drawPolicy.draw().id);
    }
  });

  it('regression guard: reconstructing without decks (the pre-fix bug) leaks cards outside the recorded deck', () => {
    const replay = recordRestrictedMatch();
    // Simulates the old ReplayScene.ts behaviour: rebuild the engine without threading replay.decks through.
    const replayedBuggy = createGameEngine(pvpConfig(SEED), new ReplayInputSource(replay));

    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(replayedBuggy.state.bottomPlayer.drawPolicy.draw().id);
    const leaked = [...seen].some((id) => !bottomDeck.includes(id));
    expect(leaked).toBe(true);
  });
});

// ── Integration: record a run, replay it, assert identical evolution ──────────

describe('record → replay reproduces the run (PvP vs AI)', () => {
  it('replaying a recorded PvP-vs-AI match yields the identical final state', () => {
    const SEED = 0xc0ffee;
    const TICKS = 600; // 20s — AI plays, units clash
    const script: PlayScript = {
      plays: { 30: [0, 1], 120: [0, 8], 300: [1, 3], 450: [0, 10] },
      upgrades: [90, 240],
    };

    // 1. Record through a RecordingInputSource wrapping a LocalInputSource.
    const rec = new RecordingInputSource(new LocalInputSource());
    const original = createGameEngine(pvpConfig(SEED), rec);
    drive(original, TICKS, script);
    const replay = rec.snapshot({ seed: SEED, mode: 'pvp' });
    const originalFp = fingerprint(original);

    // The recording captured the player's scripted commands (and nothing the AI
    // generated in-tick — those regenerate from the seed on playback).
    expect(replay.frames.length).toBeGreaterThan(0);

    // 2. Replay into a fresh engine on the same seed; pump endFrame ticks.
    const rp = new ReplayInputSource(replay);
    const replayed = createGameEngine(pvpConfig(SEED), rp);
    for (let i = 0; i < replay.endFrame; i++) replayed.tick(TICK_DT);

    expect(fingerprint(replayed)).toEqual(originalFp);
  });

  it('survives a JSON round-trip of the Replay', () => {
    const SEED = 7;
    const TICKS = 400;
    const script: PlayScript = { plays: { 20: [0, 2], 200: [0, 9] }, upgrades: [100] };

    const rec = new RecordingInputSource(new LocalInputSource());
    const original = createGameEngine(pvpConfig(SEED), rec);
    drive(original, TICKS, script);
    const originalFp = fingerprint(original);

    const replay: Replay = JSON.parse(JSON.stringify(rec.snapshot({ seed: SEED, mode: 'pvp' })));
    const replayed = createGameEngine(pvpConfig(SEED), new ReplayInputSource(replay));
    for (let i = 0; i < replay.endFrame; i++) replayed.tick(TICK_DT);

    expect(fingerprint(replayed)).toEqual(originalFp);
  });
});

describe('record → replay reproduces the run (PvE / campaign)', () => {
  it('replaying a campaign run reproduces it; enemy waves regenerate from seed', () => {
    const SEED = 12345;
    const level = CAMPAIGN_LEVELS[CAMPAIGN_LEVEL_ORDER[0]!]!;
    const cfg: GameConfig = { seed: SEED, players: [{ id: 0 }, { id: 1 }], mode: 'campaign', level };
    const TICKS = 500;
    // Player drops a couple of cards; the enemy is driven by the WaveDirector
    // (NOT a command source) so the recording stores only the player's commands.
    const script: PlayScript = { plays: { 40: [0, 1], 160: [0, 10], 320: [1, 4] }, upgrades: [80] };

    const rec = new RecordingInputSource(new LocalInputSource());
    const original = createGameEngine(cfg, rec);
    drive(original, TICKS, script);
    const replay = rec.snapshot({ seed: SEED, mode: 'campaign', configRef: level.id });
    const originalFp = fingerprint(original);

    // Every recorded command is the player's (owner 0) — the enemy never goes
    // through the input pipeline.
    for (const f of replay.frames) for (const c of f.commands) expect(c.owner).toBe(0);

    const rp = new ReplayInputSource(replay);
    const replayed = createGameEngine(cfg, rp);
    for (let i = 0; i < replay.endFrame; i++) replayed.tick(TICK_DT);

    expect(fingerprint(replayed)).toEqual(originalFp);
  });
});
