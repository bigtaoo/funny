/**
 * `game/replay/StateReplay.ts` — buildings, v1 (res-less) streams and empty streams.
 *
 * `stateReplay.test.ts` proves the hard part (keyframe thinning of moving units round-trips
 * within EPS) but its fixtures carry no buildings, always carry `res`, and are never empty — so
 * 11 branches were unreached, all of them on the building timeline plus the two "nothing to
 * encode/decode" guards.
 *
 * Buildings are worth their own file because their timeline is a different shape from a unit's:
 * they never move, so the decoder carries the last keyframe forward instead of interpolating,
 * and their disappearance is the ONLY thing that tells the shared replay a tower was destroyed.
 * Dropping an `rb` removal leaves a destroyed arrow tower standing for the rest of the replay,
 * which is not a crash and not a size regression — it is a replay that shows a different battle
 * than the one that was played.
 *
 * Two branches stay uncovered and are type-driven rather than reachable: `resSig`'s `rs ?? []`
 * (its only call site is already behind `if (!f.res) continue`) and `keptTicksForUnit`'s
 * `n === 0` early-out (it is only ever called with a non-empty sample list). Both are defensive
 * defaults kept for the signature's sake.
 */
import { describe, it, expect } from 'vitest';
import {
  encodeStateReplay,
  decodeStateReplay,
  STATE_SCHEMA_VERSION,
  type EncodedStateReplay,
  type StateBuilding,
  type StateFrame,
  type StateReplay,
  type StateUnit,
} from '../src/game/replay/StateReplay';

function header(): StateReplay['header'] {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    mode: 'pvp',
    tickRate: 30,
    endTick: 0,
    winner: 0,
    board: { cols: 12, rows: 18, lanes: [0, 1, 2, 3, 4, 7, 8, 9, 10, 11] },
    players: [{ name: 'Tao', side: 0 }, { name: 'Anna', side: 1 }],
  };
}

function replay(frames: StateFrame[]): StateReplay {
  const h = header();
  return { header: { ...h, endTick: frames.length ? frames[frames.length - 1]!.tick : 0 }, frames };
}

function tower(over: Partial<StateBuilding> = {}): StateBuilding {
  return { id: 1, type: 'arrow_tower', side: 1, col: 3, row: 17, hp: 120, maxHp: 120, ...over };
}

function unit(over: Partial<StateUnit> = {}): StateUnit {
  return { id: 10, type: 'infantry', side: 0, col: 3, row: 5, hp: 60, maxHp: 60, state: 'Moving', ...over };
}

const bases = (): StateFrame['bases'] => [
  { owner: 0, hp: 100, maxHp: 100 },
  { owner: 1, hp: 100, maxHp: 100 },
];

/** Reconstruct one decoded frame by tick (the decoder emits a full snapshot per emitted tick). */
function frameAt(dec: StateReplay, tick: number): StateFrame | undefined {
  return dec.frames.find((f) => f.tick === tick);
}

// ── Empty streams ───────────────────────────────────────────────────────────────────────────

describe('empty streams', () => {
  it('encodes and decodes a replay with no frames, keeping the header', () => {
    // A match that ended before the recorder captured a frame (an instant surrender / a rejoin
    // that resolved immediately). The header alone still has to survive, because that is what the
    // replay list renders — a throw here would break the whole shared-replay screen.
    const enc = encodeStateReplay(replay([]));
    expect(enc).toEqual({ header: expect.objectContaining({ mode: 'pvp' }), frames: [] });
    const dec = decodeStateReplay(enc);
    expect(dec.frames).toEqual([]);
    expect(dec.header).toEqual(enc.header);
  });

  it('decodes an encoded stream that carries a header but no delta frames', () => {
    const dec = decodeStateReplay({ header: header(), frames: [] } as EncodedStateReplay);
    expect(dec.frames).toEqual([]);
  });
});

// ── v1 streams with no `res` ────────────────────────────────────────────────────────────────

describe('v1 streams (no res block)', () => {
  it('round-trips frames that carry no per-owner resources', () => {
    // Schema v1 recordings predate the ink/upgrade HUD block; the encoder's change-detection has
    // to treat "absent" as a stable value rather than as a change on every single frame (which
    // would defeat the thinning entirely and re-emit every tick).
    const frames: StateFrame[] = [];
    for (let t = 0; t <= 30; t += 3) {
      frames.push({ tick: t, units: [unit({ row: 5 + t * 0.1 })], buildings: [], bases: bases() });
    }
    const enc = encodeStateReplay(replay(frames));
    expect(enc.frames.every((f) => f.rs === undefined)).toBe(true);
    // Constant-velocity movement with no state change collapses to the two bookends.
    expect(enc.frames.length).toBeLessThan(frames.length);
    const dec = decodeStateReplay(enc);
    expect(dec.frames[0]!.res).toBeUndefined();
  });

  it('emits a res block only on the ticks where ink or upgrade actually changed', () => {
    const frames: StateFrame[] = [
      { tick: 0, units: [], buildings: [], bases: bases(), res: [{ owner: 0, ink: 5, upgrade: 0 }, { owner: 1, ink: 5, upgrade: 0 }] },
      { tick: 1, units: [], buildings: [], bases: bases(), res: [{ owner: 0, ink: 5, upgrade: 0 }, { owner: 1, ink: 5, upgrade: 0 }] },
      { tick: 2, units: [], buildings: [], bases: bases(), res: [{ owner: 0, ink: 6, upgrade: 0 }, { owner: 1, ink: 5, upgrade: 0 }] },
      { tick: 3, units: [], buildings: [], bases: bases(), res: [{ owner: 0, ink: 6, upgrade: 1 }, { owner: 1, ink: 5, upgrade: 0 }] },
    ];
    const enc = encodeStateReplay(replay(frames));
    const withRes = enc.frames.filter((f) => f.rs !== undefined).map((f) => f.tick);
    expect(withRes).toEqual([0, 2, 3]);
  });
});

// ── The building timeline ───────────────────────────────────────────────────────────────────

describe('buildings', () => {
  it('carries a static building forward instead of re-emitting it every tick', () => {
    // Buildings do not move, so one keyframe should cover a long stretch — and the decoder has
    // to put it into every reconstructed frame anyway.
    const frames: StateFrame[] = [];
    for (let t = 0; t <= 20; t++) {
      frames.push({ tick: t, units: [unit({ row: 5 + t * 0.5 })], buildings: [tower()], bases: bases() });
    }
    const enc = encodeStateReplay(replay(frames));
    expect(enc.frames.filter((f) => f.b !== undefined).length).toBeLessThanOrEqual(2);

    const dec = decodeStateReplay(enc);
    for (const f of dec.frames) {
      expect(f.buildings.map((b) => b.id)).toEqual([1]);
      expect(f.buildings[0]).toMatchObject({ type: 'arrow_tower', col: 3, row: 17 });
    }
  });

  it('re-emits a building whose HP changed, and the decoder shows the new HP from that tick on', () => {
    const frames: StateFrame[] = [
      { tick: 0, units: [], buildings: [tower({ hp: 120 })], bases: bases() },
      { tick: 5, units: [], buildings: [tower({ hp: 120 })], bases: bases() },
      { tick: 10, units: [], buildings: [tower({ hp: 40 })], bases: bases() },
      { tick: 15, units: [], buildings: [tower({ hp: 40 })], bases: bases() },
    ];
    const dec = decodeStateReplay(encodeStateReplay(replay(frames)));
    expect(frameAt(dec, 0)!.buildings[0]!.hp).toBe(120);
    expect(frameAt(dec, 10)!.buildings[0]!.hp).toBe(40);
    expect(frameAt(dec, 15)!.buildings[0]!.hp).toBe(40);
  });

  it('records a destroyed building as a removal, and the decoder stops drawing it', () => {
    // The removal tick is the only signal in the stream that the tower fell. Without it the
    // replay shows an intact tower for the rest of the match.
    const frames: StateFrame[] = [
      { tick: 0, units: [], buildings: [tower()], bases: bases() },
      { tick: 5, units: [], buildings: [tower({ hp: 20 })], bases: bases() },
      { tick: 10, units: [], buildings: [], bases: bases() },
      { tick: 15, units: [], buildings: [], bases: bases() },
    ];
    const enc = encodeStateReplay(replay(frames));
    expect(enc.frames.some((f) => f.rb?.includes(1))).toBe(true);

    const dec = decodeStateReplay(enc);
    expect(frameAt(dec, 0)!.buildings).toHaveLength(1);
    expect(frameAt(dec, 5)!.buildings).toHaveLength(1);
    expect(frameAt(dec, 10)!.buildings).toHaveLength(0);
    expect(frameAt(dec, 15)!.buildings).toHaveLength(0);
  });

  it('does not draw a building before the tick it was built on', () => {
    // Barracks/towers appear mid-match; a building's first keyframe is its build tick, and the
    // decoder must not back-date it into earlier frames.
    const frames: StateFrame[] = [
      { tick: 0, units: [], buildings: [], bases: bases() },
      { tick: 5, units: [], buildings: [], bases: bases() },
      { tick: 10, units: [], buildings: [tower({ id: 7 })], bases: bases() },
      { tick: 15, units: [], buildings: [tower({ id: 7 })], bases: bases() },
    ];
    const dec = decodeStateReplay(encodeStateReplay(replay(frames)));
    // Tick 5 carries no entities and no changes, so it is not emitted at all — the assertion is
    // on the frames that exist: nothing before the build tick, the tower from it onwards.
    expect(dec.frames[0]!.tick).toBe(0);
    expect(dec.frames[0]!.buildings).toHaveLength(0);
    expect(frameAt(dec, 5)).toBeUndefined();
    expect(frameAt(dec, 10)!.buildings.map((b) => b.id)).toEqual([7]);
    expect(frameAt(dec, 15)!.buildings.map((b) => b.id)).toEqual([7]);
  });

  it('does not draw a unit before the tick it spawned on, or after it died', () => {
    // The unit equivalent of the building case above, and the one the existing suite misses:
    // its fixtures have every unit present in frame 0. A unit back-dated into earlier frames
    // shows a reinforcement standing on the board before it was ever played.
    const frames: StateFrame[] = [
      { tick: 0, units: [unit({ id: 1, row: 5 })], buildings: [], bases: bases() },
      { tick: 10, units: [unit({ id: 1, row: 8 }), unit({ id: 2, row: 1, state: 'Moving' })], buildings: [], bases: bases() },
      { tick: 20, units: [unit({ id: 2, row: 4, state: 'Attacking' })], buildings: [], bases: bases() },
      { tick: 30, units: [unit({ id: 2, row: 4, state: 'Attacking' })], buildings: [], bases: bases() },
    ];
    const dec = decodeStateReplay(encodeStateReplay(replay(frames)));
    expect(dec.frames[0]!.units.map((u) => u.id)).toEqual([1]);
    expect(frameAt(dec, 10)!.units.map((u) => u.id)).toEqual([1, 2]);
    expect(frameAt(dec, 20)!.units.map((u) => u.id)).toEqual([2]);
    expect(frameAt(dec, 30)!.units.map((u) => u.id)).toEqual([2]);
  });

  it('keeps several buildings apart, including one destroyed while another survives', () => {
    const frames: StateFrame[] = [
      { tick: 0, units: [], buildings: [tower({ id: 1, col: 3 }), tower({ id: 2, col: 8 })], bases: bases() },
      { tick: 10, units: [], buildings: [tower({ id: 2, col: 8 })], bases: bases() },
      { tick: 20, units: [], buildings: [tower({ id: 2, col: 8, hp: 10 })], bases: bases() },
    ];
    const dec = decodeStateReplay(encodeStateReplay(replay(frames)));
    expect(frameAt(dec, 0)!.buildings.map((b) => b.id)).toEqual([1, 2]);
    expect(frameAt(dec, 10)!.buildings.map((b) => b.id)).toEqual([2]);
    expect(frameAt(dec, 20)!.buildings[0]!.hp).toBe(10);
  });

  it('emits sorted ids so two decodes of the same stream are identical', () => {
    const frames: StateFrame[] = [
      { tick: 0, units: [unit({ id: 9 }), unit({ id: 2 })], buildings: [tower({ id: 5 }), tower({ id: 3, col: 9 })], bases: bases() },
      { tick: 10, units: [unit({ id: 2 })], buildings: [tower({ id: 3, col: 9 })], bases: bases() },
    ];
    const dec = decodeStateReplay(encodeStateReplay(replay(frames)));
    expect(dec.frames[0]!.units.map((u) => u.id)).toEqual([2, 9]);
    expect(dec.frames[0]!.buildings.map((b) => b.id)).toEqual([3, 5]);
  });
});
