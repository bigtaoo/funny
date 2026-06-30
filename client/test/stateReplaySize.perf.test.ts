// Size benchmark (assertion is secondary; primary output is console logs): synthesize a ~10-minute match with ~50 on-field units,
// run encode (keyframe decimation) → gzip → base64, and measure the actual share-blob size + restoration fidelity.
// Run: npx vitest run test/stateReplaySize.perf.test.ts
import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  encodeStateReplay,
  decodeStateReplay,
  quantizePos,
  quantizeHp,
  STATE_SCHEMA_VERSION,
  type StateReplay,
  type StateFrame,
  type StateUnit,
  type StateBuilding,
} from '../src/game/replay/StateReplay';

// Deterministic PRNG (reproducible).
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904126) >>> 0;
    return s / 0xffffffff;
  };
}

const TICK_RATE = 30;
const DURATION_S = 600; // 10 minutes
const RAW_TICKS = DURATION_S * TICK_RATE; // 18000 = recorder single-slot cap MAX_FRAMES (StateRecorder)
const TARGET_ALIVE = 50;
const LANES = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];

interface SimUnit {
  id: number;
  type: string;
  side: 0 | 1;
  row: number; // current lane (largely fixed)
  col: number;
  vCol: number; // column velocity per tick
  hp: number;
  maxHp: number;
  state: string;
  bornTick: number;
  phaseUntil: number; // tick at which the current phase ends
}

function genReplay(totalTicks: number): StateReplay {
  const rnd = lcg(0xc0ffee);
  const types = ['infantry', 'archer', 'cavalry', 'mage'];
  const units = new Map<number, SimUnit>();
  let nextId = 1000;
  const frames: StateFrame[] = [];

  const buildings: StateBuilding[] = [];
  for (let s = 0; s < 2; s++) {
    for (let k = 0; k < 3; k++) {
      buildings.push({
        id: 1 + s * 3 + k,
        type: 'barracks',
        side: s as 0 | 1,
        col: 2 + k * 3,
        row: s === 0 ? 1 : 16,
        hp: 300,
        maxHp: 300,
      });
    }
  }
  let base0 = 100, base1 = 100;

  function spawn(tick: number): void {
    const side = (rnd() < 0.5 ? 0 : 1) as 0 | 1;
    const lane = LANES[Math.floor(rnd() * LANES.length)]!;
    const maxHp = 60 + Math.floor(rnd() * 80);
    units.set(nextId, {
      id: nextId,
      type: types[Math.floor(rnd() * types.length)]!,
      side,
      row: lane,
      col: side === 0 ? 0.5 : 11.5,
      vCol: (side === 0 ? 1 : -1) * (0.03 + rnd() * 0.05),
      hp: maxHp,
      maxHp,
      state: 'moving',
      bornTick: tick,
      phaseUntil: tick + 150 + Math.floor(rnd() * 450), // enters combat after 5~20 seconds of marching
    });
    nextId++;
  }

  for (let alive = 0; alive < TARGET_ALIVE; alive++) spawn(0);

  for (let tick = 0; tick < totalTicks; tick++) {
    // Advance each unit.
    for (const u of [...units.values()]) {
      if (u.state === 'moving') {
        u.col += u.vCol;
        // Occasional lane change (waypoint).
        if (rnd() < 0.004) {
          const idx = LANES.indexOf(u.row);
          const nidx = Math.max(0, Math.min(LANES.length - 1, idx + (rnd() < 0.5 ? -1 : 1)));
          u.row = LANES[nidx]!;
        }
        if (u.col <= 0.5 || u.col >= 11.5 || tick >= u.phaseUntil) {
          u.state = 'attacking';
          u.phaseUntil = tick + 60 + Math.floor(rnd() * 240);
        }
      } else {
        // attacking: position largely unchanged; periodic HP loss; occasional base/building damage.
        if (tick % 18 === 0) u.hp = Math.max(0, u.hp - (4 + Math.floor(rnd() * 14)));
        if (rnd() < 0.02) (u.side === 0 ? (base1 = Math.max(0, base1 - 1)) : (base0 = Math.max(0, base0 - 1)));
        if (rnd() < 0.01) {
          const b = buildings[Math.floor(rnd() * buildings.length)]!;
          b.hp = Math.max(0, b.hp - (5 + Math.floor(rnd() * 20)));
        }
        if (u.hp <= 0 || tick >= u.phaseUntil) {
          units.delete(u.id); // dead / retreated
        }
      }
    }
    // Replenish troops.
    while (units.size < TARGET_ALIVE && rnd() < 0.9) spawn(tick);

    // Snapshot the current frame.
    const us: StateUnit[] = [];
    for (const u of units.values()) {
      us.push({
        id: u.id,
        type: u.type,
        side: u.side,
        col: quantizePos(u.col),
        row: quantizePos(u.row),
        hp: quantizeHp(u.hp),
        maxHp: quantizeHp(u.maxHp),
        state: u.state,
      });
    }
    frames.push({
      tick,
      units: us,
      buildings: buildings.map((b) => ({ ...b, hp: quantizeHp(b.hp) })),
      bases: [
        { owner: 0, hp: quantizeHp(base0), maxHp: 100 },
        { owner: 1, hp: quantizeHp(base1), maxHp: 100 },
      ],
    });
  }

  return {
    header: {
      schemaVersion: STATE_SCHEMA_VERSION,
      mode: 'pvp',
      tickRate: TICK_RATE,
      endTick: totalTicks - 1,
      winner: 0,
      board: { cols: 12, rows: 18, lanes: [...LANES] },
      players: [{ name: 'Tao', side: 0 }, { name: 'Anna', side: 1 }],
    },
    frames,
  };
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

describe('State replay share size benchmark (10 min / ~50 units)', () => {
  it(`Measure share blob size + decimation ratio + gzip ratio + fidelity @10min(${RAW_TICKS} frames)`, () => {
    const cappedTicks = RAW_TICKS;
    const replay = genReplay(cappedTicks);

    const totalUnits = new Set<number>();
    let unitFrameCells = 0;
    let peakAlive = 0;
    for (const f of replay.frames) {
      peakAlive = Math.max(peakAlive, f.units.length);
      unitFrameCells += f.units.length;
      for (const u of f.units) totalUnits.add(u.id);
    }

    // Old approach approximation: full-frame JSON (complete state per frame).
    const fullJsonBytes = Buffer.byteLength(JSON.stringify(replay));

    // New approach: keyframe-decimated delta JSON.
    const enc = encodeStateReplay(replay);
    const encJson = JSON.stringify(enc);
    const encBytes = Buffer.byteLength(encJson);

    // gzip (client uses CompressionStream('gzip'), ratio equivalent to zlib.gzip).
    const gz = gzipSync(Buffer.from(encJson), { level: 9 });
    const gzBytes = gz.length;
    // Actual upload payload is base64(gzip).
    const b64Bytes = Math.ceil(gzBytes / 3) * 4;

    const CAP = 2 * 1024 * 1024;

    // Restoration fidelity spot-check: reconstruct at several ticks using the player interpolation model, verify position error ≤ EPS and discrete fields are exact.
    const dec = decodeStateReplay(enc);
    const EPS = 0.06;
    const checkTicks = [0, 100, 1500, 6000, cappedTicks - 1];
    let maxPosErr = 0, staticMismatch = 0, checkedUnits = 0;
    for (const tk of checkTicks) {
      const orig = replay.frames[tk]!;
      // Reconstruct (mirrors StatePlayerScene).
      const fr = dec.frames;
      let cur = 0;
      while (cur < fr.length - 1 && fr[cur + 1]!.tick <= tk) cur++;
      const a = fr[cur]!, b = fr[Math.min(cur + 1, fr.length - 1)]!;
      const span = b.tick - a.tick;
      const frac = span > 0 ? Math.max(0, Math.min(1, (tk - a.tick) / span)) : 0;
      const bById = new Map(b.units.map((u) => [u.id, u] as const));
      const recon = new Map<number, StateUnit>();
      for (const u of a.units) {
        const nb = bById.get(u.id);
        recon.set(u.id, { ...u, col: nb ? u.col + (nb.col - u.col) * frac : u.col, row: nb ? u.row + (nb.row - u.row) * frac : u.row });
      }
      for (const u of orig.units) {
        const g = recon.get(u.id);
        if (!g) { staticMismatch++; continue; }
        checkedUnits++;
        maxPosErr = Math.max(maxPosErr, Math.abs(g.col - u.col), Math.abs(g.row - u.row));
        if (g.state !== u.state || g.hp !== u.hp) staticMismatch++;
      }
    }

    /* eslint-disable no-console */
    console.log('\n========= State replay share size benchmark =========');
    console.log(`Recorded frames:  ${replay.frames.length} (${(replay.frames.length / TICK_RATE / 60).toFixed(1)} min @${TICK_RATE}Hz = recorder MAX_FRAMES full)`);
    console.log(`Peak alive units: ${peakAlive}    Total unique units: ${totalUnits.size}`);
    console.log(`Unit·frame cells: ${unitFrameCells.toLocaleString()}`);
    console.log('--------------------------------------');
    console.log(`① Full-frame JSON (old approach approx): ${kb(fullJsonBytes)}`);
    console.log(`② Keyframe-decimated delta JSON:         ${kb(encBytes)}   (saved ${(100 * (1 - encBytes / fullJsonBytes)).toFixed(1)}% vs full)`);
    console.log(`③ After gzip:                            ${kb(gzBytes)}   (gzip saves another ${(100 * (1 - gzBytes / encBytes)).toFixed(1)}%)`);
    console.log(`④ base64(gzip) actual upload:            ${kb(b64Bytes)}`);
    console.log(`   delta frames: ${enc.frames.length} / ${replay.frames.length}`);
    console.log('--------------------------------------');
    console.log(`Upload size / cap (2MB): ${kb(b64Bytes)} / ${kb(CAP)}  →  ${b64Bytes <= CAP ? '✅ pass' : '❌ over limit'}`);
    console.log(`Under old 512KB cap: ${b64Bytes <= 512 * 1024 ? 'also passes' : 'would be rejected (old cap too low)'}`);
    console.log(`Fidelity: max pos error ${maxPosErr.toFixed(4)} cells (EPS=${EPS}), static mismatch ${staticMismatch}/${checkedUnits} sampled units`);
    console.log('======================================\n');
    /* eslint-enable no-console */

    expect(b64Bytes).toBeLessThanOrEqual(CAP);
    expect(maxPosErr).toBeLessThanOrEqual(EPS);
    expect(staticMismatch).toBe(0);
  }, 30000);
});
