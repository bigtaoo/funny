// State-stream replay delta encode/decode + keyframe thinning (REPLAY_SHARE_DESIGN §6/§7).
//
// The encoder no longer re-emits positions every frame: uniform straight-line movement is collapsed to endpoints;
// inflection points / state changes / endpoints become keyframes; intermediate frames are discarded and
// reconstructed by the dumb player with per-tick linear interpolation.
// Therefore the round-trip **no longer requires per-frame deep equality**; instead, at each original tick
// the reconstructed position error must be ≤ EPS and static fields (state / HP / type / side) must match exactly.
import { describe, it, expect } from 'vitest';
import {
  encodeStateReplay,
  decodeStateReplay,
  quantizePos,
  STATE_SCHEMA_VERSION,
  type StateReplay,
  type StateFrame,
  type StateUnit,
} from '../src/game/replay/StateReplay';

const EPS = 0.06; // matches the encoder's POS_KEYFRAME_EPS

function mkReplay(frames: StateFrame[]): StateReplay {
  return {
    header: {
      schemaVersion: STATE_SCHEMA_VERSION,
      mode: 'pvp',
      tickRate: 30,
      endTick: frames.length ? frames[frames.length - 1]!.tick : 0,
      winner: 0,
      board: { cols: 12, rows: 18, lanes: [0, 1, 2, 3, 4, 7, 8, 9, 10, 11] },
      players: [
        { name: 'Tao', side: 0 },
        { name: 'Anna', side: 1 },
      ],
    },
    frames,
  };
}

/**
 * Mirrors StatePlayerScene's per-tick interpolation: take frame a (a.tick ≤ tick) and the next frame b,
 * linearly interpolate the position of units present in both a and b at the given tick proportion;
 * units only in a retain their own values. Returns a map of id → reconstructed unit.
 */
function reconstructUnitsAt(dec: StateReplay, tick: number): Map<number, StateUnit> {
  const frames = dec.frames;
  let cur = 0;
  while (cur < frames.length - 1 && frames[cur + 1]!.tick <= tick) cur++;
  const a = frames[cur]!;
  const b = frames[Math.min(cur + 1, frames.length - 1)]!;
  const span = b.tick - a.tick;
  const frac = span > 0 ? Math.max(0, Math.min(1, (tick - a.tick) / span)) : 0;
  const bById = new Map(b.units.map((u) => [u.id, u] as const));
  const out = new Map<number, StateUnit>();
  for (const u of a.units) {
    const nb = bById.get(u.id);
    out.set(u.id, {
      ...u,
      col: nb ? u.col + (nb.col - u.col) * frac : u.col,
      row: nb ? u.row + (nb.row - u.row) * frac : u.row,
    });
  }
  return out;
}

/** Verify reconstruction fidelity at every original tick (position ≤ EPS, static fields exact). */
function assertFaithful(original: StateReplay): StateReplay {
  const enc = encodeStateReplay(original);
  const dec = decodeStateReplay(enc);
  for (const f of original.frames) {
    const got = reconstructUnitsAt(dec, f.tick);
    for (const u of f.units) {
      const g = got.get(u.id);
      expect(g, `unit ${u.id} present at tick ${f.tick}`).toBeDefined();
      expect(Math.abs(g!.col - u.col), `unit ${u.id} col@${f.tick}`).toBeLessThanOrEqual(EPS);
      expect(Math.abs(g!.row - u.row), `unit ${u.id} row@${f.tick}`).toBeLessThanOrEqual(EPS);
      expect(g!.state, `unit ${u.id} state@${f.tick}`).toBe(u.state);
      expect(g!.hp, `unit ${u.id} hp@${f.tick}`).toBe(u.hp);
      expect(g!.maxHp).toBe(u.maxHp);
      expect(g!.type).toBe(u.type);
      expect(g!.side).toBe(u.side);
    }
  }
  expect(dec.header).toEqual(original.header);
  return enc;
}

describe('StateReplay keyframe-thinning encode/decode', () => {
  it('uniform straight-line movement collapsed to endpoints (intermediate frames dropped, restored by interpolation)', () => {
    // Unit moves along row at constant speed 0..6, 11 frames with no state change.
    const frames: StateFrame[] = [];
    for (let t = 0; t <= 10; t++) {
      frames.push({
        tick: t,
        units: [{ id: 1, type: 'infantry', side: 0, col: 3, row: quantizePos(0.6 * t), hp: 100, maxHp: 100, state: 'moving' }],
        buildings: [],
        bases: [{ owner: 0, hp: 100, maxHp: 100 }, { owner: 1, hp: 100, maxHp: 100 }],
      });
    }
    const enc = assertFaithful(mkReplay(frames));
    // Straight segment collapsed: unit keyframes far fewer than 11 (only near endpoints).
    const unitFrames = enc.frames.filter((df) => df.u?.some((u) => u.id === 1)).length;
    expect(unitFrames).toBeLessThanOrEqual(3);
    expect(enc.frames.length).toBeLessThan(frames.length);
  });

  it('inflection point forces a keyframe (L-shaped path is not short-circuited by interpolation)', () => {
    // t0..5 moves up along row; t5..10 moves right along col — t5 is the inflection point.
    const frames: StateFrame[] = [];
    for (let t = 0; t <= 10; t++) {
      const row = t <= 5 ? quantizePos(0.6 * t) : quantizePos(3);
      const col = t <= 5 ? 2 : quantizePos(2 + 0.6 * (t - 5));
      frames.push({
        tick: t,
        units: [{ id: 1, type: 'infantry', side: 0, col, row, hp: 100, maxHp: 100, state: 'moving' }],
        buildings: [],
        bases: [{ owner: 0, hp: 100, maxHp: 100 }, { owner: 1, hp: 100, maxHp: 100 }],
      });
    }
    assertFaithful(mkReplay(frames)); // fidelity assertions already cover the inflection point (otherwise error near t5 would exceed EPS)
  });

  it('state/HP transitions are exact keyframes; death produces a ru entry', () => {
    const frames: StateFrame[] = [
      { tick: 0, units: [{ id: 1, type: 'infantry', side: 0, col: 3, row: 1, hp: 100, maxHp: 100, state: 'moving' }], buildings: [], bases: [{ owner: 0, hp: 100, maxHp: 100 }, { owner: 1, hp: 100, maxHp: 100 }] },
      { tick: 1, units: [{ id: 1, type: 'infantry', side: 0, col: 3, row: 2, hp: 100, maxHp: 100, state: 'moving' }], buildings: [], bases: [{ owner: 0, hp: 100, maxHp: 100 }, { owner: 1, hp: 100, maxHp: 100 }] },
      // t2: moving → attacking + HP drop (discrete event, must be captured as an exact keyframe)
      { tick: 2, units: [{ id: 1, type: 'infantry', side: 0, col: 3, row: 3, hp: 70, maxHp: 100, state: 'attacking' }], buildings: [], bases: [{ owner: 0, hp: 100, maxHp: 100 }, { owner: 1, hp: 100, maxHp: 100 }] },
      // t3: death (unit disappears)
      { tick: 3, units: [], buildings: [], bases: [{ owner: 0, hp: 100, maxHp: 100 }, { owner: 1, hp: 100, maxHp: 100 }] },
    ];
    const enc = assertFaithful(mkReplay(frames));
    // t2 must appear as a keyframe (with the new state/HP).
    const at2 = enc.frames.find((df) => df.tick === 2);
    expect(at2?.u?.find((u) => u.id === 1)?.state).toBe('attacking');
    expect(at2?.u?.find((u) => u.id === 1)?.hp).toBe(70);
    // Death produces a ru entry.
    expect(enc.frames.some((df) => df.ru?.includes(1))).toBe(true);
  });

  it('building changes and base damage are preserved', () => {
    const frames: StateFrame[] = [
      { tick: 0, units: [], buildings: [{ id: 9, type: 'barracks', side: 0, col: 3, row: 0, hp: 200, maxHp: 200 }], bases: [{ owner: 0, hp: 100, maxHp: 100 }, { owner: 1, hp: 100, maxHp: 100 }] },
      { tick: 1, units: [], buildings: [{ id: 9, type: 'barracks', side: 0, col: 3, row: 0, hp: 200, maxHp: 200 }], bases: [{ owner: 0, hp: 100, maxHp: 100 }, { owner: 1, hp: 100, maxHp: 100 }] },
      { tick: 2, units: [], buildings: [{ id: 9, type: 'barracks', side: 0, col: 3, row: 0, hp: 150, maxHp: 200 }], bases: [{ owner: 0, hp: 92, maxHp: 100 }, { owner: 1, hp: 100, maxHp: 100 }] },
    ];
    const dec = decodeStateReplay(encodeStateReplay(mkReplay(frames)));
    // Last frame reconstruction must reflect building HP loss + base damage.
    const last = dec.frames[dec.frames.length - 1]!;
    expect(last.buildings.find((b) => b.id === 9)?.hp).toBe(150);
    // The most recent base change (t2) is recorded.
    const enc = encodeStateReplay(mkReplay(frames));
    expect(enc.frames.find((df) => df.tick === 2)?.bs?.find((b) => b.owner === 0)?.hp).toBe(92);
  });

  it('three fully static frames collapse to first and last (empty intermediate frame dropped)', () => {
    const stable: StateFrame = {
      tick: 0,
      units: [{ id: 1, type: 'infantry', side: 0, col: 3, row: 1, hp: 100, maxHp: 100, state: 'idle' }],
      buildings: [{ id: 9, type: 'barracks', side: 0, col: 3, row: 0, hp: 200, maxHp: 200 }],
      bases: [{ owner: 0, hp: 100, maxHp: 100 }, { owner: 1, hp: 100, maxHp: 100 }],
    };
    const enc = encodeStateReplay(mkReplay([{ ...stable, tick: 0 }, { ...stable, tick: 1 }, { ...stable, tick: 2 }]));
    // Intermediate tick=1 has no changes → dropped; only the first frame (with data) + last frame as a floor remain.
    expect(enc.frames.some((df) => df.tick === 1)).toBe(false);
    expect(enc.frames[0]!.tick).toBe(0);
    expect(enc.frames[0]!.u).toBeDefined();
  });

  it('quantizePos rounds to 2 decimals', () => {
    expect(quantizePos(3.14159)).toBe(3.14);
    expect(quantizePos(7.005)).toBeCloseTo(7.01, 5);
  });
});
