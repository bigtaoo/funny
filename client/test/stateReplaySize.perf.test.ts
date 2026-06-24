// 体量实测（非断言主目的，主要 console 输出）：合成一场约 10 分钟、场上 ~50 单位的对战，
// 跑 encode（关键帧抽稀）→ gzip → base64，量分享 blob 实际大小 + 还原保真度。
// 运行：npx vitest run test/stateReplaySize.perf.test.ts
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

// 确定性 PRNG（可复现）。
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904126) >>> 0;
    return s / 0xffffffff;
  };
}

const TICK_RATE = 30;
const DURATION_S = 600; // 10 分钟
const RAW_TICKS = DURATION_S * TICK_RATE; // 18000
const MAX_FRAMES = 12000; // 录制器单槽上限（StateRecorder），10 分钟会被截到 ~6.7 分钟
const TARGET_ALIVE = 50;
const LANES = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];

interface SimUnit {
  id: number;
  type: string;
  side: 0 | 1;
  row: number; // 所在 lane（基本固定）
  col: number;
  vCol: number; // 每 tick 列速度
  hp: number;
  maxHp: number;
  state: string;
  bornTick: number;
  phaseUntil: number; // 当前阶段结束 tick
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
      phaseUntil: tick + 150 + Math.floor(rnd() * 450), // 走 5~20 秒后进入交战
    });
    nextId++;
  }

  for (let alive = 0; alive < TARGET_ALIVE; alive++) spawn(0);

  for (let tick = 0; tick < totalTicks; tick++) {
    // 推进每个单位。
    for (const u of [...units.values()]) {
      if (u.state === 'moving') {
        u.col += u.vCol;
        // 偶发变道（拐点）。
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
        // attacking：位置基本不动，周期性掉血；偶尔基地/建筑受损。
        if (tick % 18 === 0) u.hp = Math.max(0, u.hp - (4 + Math.floor(rnd() * 14)));
        if (rnd() < 0.02) (u.side === 0 ? (base1 = Math.max(0, base1 - 1)) : (base0 = Math.max(0, base0 - 1)));
        if (rnd() < 0.01) {
          const b = buildings[Math.floor(rnd() * buildings.length)]!;
          b.hp = Math.max(0, b.hp - (5 + Math.floor(rnd() * 20)));
        }
        if (u.hp <= 0 || tick >= u.phaseUntil) {
          units.delete(u.id); // 死亡/撤离
        }
      }
    }
    // 维持兵力。
    while (units.size < TARGET_ALIVE && rnd() < 0.9) spawn(tick);

    // 快照当帧。
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

describe('状态流分享体量实测（10 分钟 / ~50 单位）', () => {
  // 两档：当前录制上限（MAX_FRAMES=12000≈6.7min）与「若放开上限」的整 10 分钟（18000 帧）。
  for (const ticks of [Math.min(RAW_TICKS, MAX_FRAMES), RAW_TICKS]) {
  it(`量分享 blob 大小 + 抽稀比 + gzip 比 + 保真度 @${ticks}帧(${(ticks / TICK_RATE / 60).toFixed(1)}min)`, () => {
    const cappedTicks = ticks;
    const replay = genReplay(cappedTicks);

    const totalUnits = new Set<number>();
    let unitFrameCells = 0;
    let peakAlive = 0;
    for (const f of replay.frames) {
      peakAlive = Math.max(peakAlive, f.units.length);
      unitFrameCells += f.units.length;
      for (const u of f.units) totalUnits.add(u.id);
    }

    // 旧方案近似：满帧 JSON（逐帧全量）。
    const fullJsonBytes = Buffer.byteLength(JSON.stringify(replay));

    // 新方案：关键帧抽稀 delta JSON。
    const enc = encodeStateReplay(replay);
    const encJson = JSON.stringify(enc);
    const encBytes = Buffer.byteLength(encJson);

    // gzip（客户端用 CompressionStream('gzip')，比率与 zlib.gzip 等价）。
    const gz = gzipSync(Buffer.from(encJson), { level: 9 });
    const gzBytes = gz.length;
    // 实际上传是 base64(gzip)。
    const b64Bytes = Math.ceil(gzBytes / 3) * 4;

    const CAP = 2 * 1024 * 1024;

    // 还原保真度抽检：在若干 tick 上按播放器插值模型重建，校验位置 ≤ EPS、静态精确。
    const dec = decodeStateReplay(enc);
    const EPS = 0.06;
    const checkTicks = [0, 100, 1500, 6000, cappedTicks - 1];
    let maxPosErr = 0, staticMismatch = 0, checkedUnits = 0;
    for (const tk of checkTicks) {
      const orig = replay.frames[tk]!;
      // 重建（镜像 StatePlayerScene）。
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
    console.log('\n========= 状态流分享体量实测 =========');
    console.log(`录制帧数:        ${replay.frames.length}（${(replay.frames.length / TICK_RATE / 60).toFixed(1)} 分钟 @${TICK_RATE}Hz；10 分钟被 MAX_FRAMES=${MAX_FRAMES} 截断）`);
    console.log(`场上峰值单位:    ${peakAlive}    全程不同单位总数: ${totalUnits.size}`);
    console.log(`单位·帧 采样数:  ${unitFrameCells.toLocaleString()}`);
    console.log('--------------------------------------');
    console.log(`① 满帧 JSON（旧方案近似）: ${kb(fullJsonBytes)}`);
    console.log(`② 关键帧抽稀 delta JSON:   ${kb(encBytes)}   (抽稀后省 ${(100 * (1 - encBytes / fullJsonBytes)).toFixed(1)}%)`);
    console.log(`③ gzip 后:                 ${kb(gzBytes)}   (gzip 再省 ${(100 * (1 - gzBytes / encBytes)).toFixed(1)}%)`);
    console.log(`④ base64(gzip) 实际上传:   ${kb(b64Bytes)}`);
    console.log(`   delta 帧数: ${enc.frames.length} / ${replay.frames.length}`);
    console.log('--------------------------------------');
    console.log(`上传体量 / 上限(2MB): ${kb(b64Bytes)} / ${kb(CAP)}  →  ${b64Bytes <= CAP ? '✅ 通过' : '❌ 超限'}`);
    console.log(`旧 512KB 上限下: ${b64Bytes <= 512 * 1024 ? '也能过' : '会被拒（故旧上限需上调）'}`);
    console.log(`保真度: 最大位置误差 ${maxPosErr.toFixed(4)} 格 (EPS=${EPS}), 静态不符 ${staticMismatch}/${checkedUnits} 抽检单位`);
    console.log('======================================\n');
    /* eslint-enable no-console */

    expect(b64Bytes).toBeLessThanOrEqual(CAP);
    expect(maxPosErr).toBeLessThanOrEqual(EPS);
    expect(staticMismatch).toBe(0);
  }, 30000);
  }
});
