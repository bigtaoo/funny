// StateRecorder recording-path unit tests (REPLAY_SHARE_DESIGN §2.1).
// Drives the singleton recorder with a structured fake GameState; verifies:
// frame capture / same-tick skip / tick-rewind auto-reset /
// build header (geometry / players / winner / endTick) / decode round-trip / adopt passthrough.
import { describe, it, expect, beforeEach } from 'vitest';
import { stateRecorder } from '../src/game/replay/StateRecorder';
import { decodeStateReplay, type EncodedStateReplay } from '../src/game/replay/StateReplay';
import { Side, UnitType, UnitState, BuildingType } from '../src/game';
import type { GameState } from '../src/game';

interface FakeUnit {
  id: number; unitType: UnitType; side: Side;
  colExact: number; rowExact: number; hp: number; maxHp: number; state: UnitState;
}
interface FakeBuilding {
  id: number; buildingType: BuildingType; side: Side;
  col: number; row: number; hp: number; maxHp: number;
}

function mkState(
  tick: number,
  units: FakeUnit[] = [],
  buildings: FakeBuilding[] = [],
  baseBottom = 100,
  baseTop = 100,
): GameState {
  return {
    elapsedTicks: tick,
    bottomPlayer: { baseHp: baseBottom },
    topPlayer: { baseHp: baseTop },
    board: {
      units: new Map(units.map((u) => [u.id, u])),
      buildings: new Map(buildings.map((b) => [b.id, b])),
    },
  } as unknown as GameState;
}

const unit = (over: Partial<FakeUnit> = {}): FakeUnit => ({
  id: 1000, unitType: UnitType.Infantry, side: Side.Bottom,
  colExact: 3, rowExact: 1, hp: 100, maxHp: 100, state: UnitState.Moving, ...over,
});

describe('StateRecorder', () => {
  beforeEach(() => stateRecorder.reset());

  it('captures one frame per advanced tick and skips repeat ticks', () => {
    stateRecorder.capture(mkState(0));
    stateRecorder.capture(mkState(0)); // duplicate render frame at same tick → skip
    stateRecorder.capture(mkState(1, [unit({ rowExact: 2.5 })]));

    const enc = stateRecorder.build({ mode: 'pvp', winner: 0 });
    expect(enc).not.toBeNull();
    const dec = decodeStateReplay(enc!);
    expect(dec.frames.length).toBe(2);
    expect(dec.frames[0]!.tick).toBe(0);
    expect(dec.frames[1]!.tick).toBe(1);
    expect(dec.frames[1]!.units[0]).toMatchObject({ id: 1000, type: 'infantry', side: 0, row: 2.5 });
  });

  it('quantizes positions to 2 decimals and hp to integers', () => {
    stateRecorder.capture(mkState(0, [unit({ colExact: 3.14159, rowExact: 7.005, hp: 88.7 })]));
    const dec = decodeStateReplay(stateRecorder.build()!);
    const u = dec.frames[0]!.units[0]!;
    expect(u.col).toBe(3.14);
    expect(u.row).toBeCloseTo(7.01, 5);
    expect(u.hp).toBe(89);
  });

  it('records buildings and both bases', () => {
    const b: FakeBuilding = {
      id: 1, buildingType: BuildingType.Barracks, side: Side.Bottom, col: 3, row: 0, hp: 200, maxHp: 200,
    };
    stateRecorder.capture(mkState(0, [], [b], 95, 100));
    const f = decodeStateReplay(stateRecorder.build()!).frames[0]!;
    expect(f.buildings[0]).toMatchObject({ id: 1, type: 'barracks', side: 0 });
    expect(f.bases).toEqual([
      { owner: 0, hp: 95, maxHp: 95 }, // first frame anchors full-HP baseline = current frame value
      { owner: 1, hp: 100, maxHp: 100 },
    ]);
  });

  it('auto-resets when tick rewinds (new match / new replay)', () => {
    stateRecorder.capture(mkState(0));
    stateRecorder.capture(mkState(5));
    stateRecorder.capture(mkState(0)); // tick rewinds → treated as a new match, auto-reset
    const enc = stateRecorder.build()!;
    expect(decodeStateReplay(enc).frames.length).toBe(1);
  });

  it('build header carries geometry, players, winner override and endTick', () => {
    stateRecorder.capture(mkState(0));
    stateRecorder.capture(mkState(3));
    stateRecorder.setWinner(1);
    const enc = stateRecorder.build({
      mode: 'campaign',
      players: [{ name: 'Tao', side: 0 }, { name: 'AI', side: 1 }],
    })!;
    expect(enc.header.mode).toBe('campaign');
    expect(enc.header.winner).toBe(1); // from setWinner during recording (override did not supply winner)
    expect(enc.header.endTick).toBe(3);
    expect(enc.header.board.cols).toBe(12);
    expect(enc.header.players[0]).toEqual({ name: 'Tao', side: 0 });
    // override.winner takes precedence over setWinner
    expect(stateRecorder.build({ winner: 0 })!.header.winner).toBe(0);
  });

  it('build returns null when nothing captured', () => {
    expect(stateRecorder.build()).toBeNull();
  });

  it('adopt forwards the original encoded stream verbatim (re-share)', () => {
    const original = { header: { schemaVersion: 1, endTick: 9 }, frames: [{ tick: 0 }] } as unknown as EncodedStateReplay;
    stateRecorder.adopt(original);
    // Even if more frames are captured after adopt, adopt wins and the original is returned as-is.
    stateRecorder.capture(mkState(0));
    expect(stateRecorder.build()).toBe(original);
  });
});
