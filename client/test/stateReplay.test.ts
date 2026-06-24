// 状态流录像 delta 编解码 + 关键帧抽稀（REPLAY_SHARE_DESIGN §6/§7）。
//
// 编码器不再逐帧重发位置：匀速直线行走塌缩为端点，拐点/状态切换/端点落关键帧，中间帧丢弃，
// 由哑播放器按 tick 线性插值还原。故 round-trip **不再逐帧深等**，而是「在每个原始 tick 上，
// 按播放器的插值模型重建后，位置误差 ≤ EPS、静态字段（状态/血量/类型/阵营）精确一致」。
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

const EPS = 0.06; // 与编码器 POS_KEYFRAME_EPS 一致

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
 * 镜像 StatePlayerScene 的逐 tick 插值：取 frame a (a.tick ≤ tick) 与下一帧 b，按 tick 比例线性
 * 插值同时存在于 a/b 的单位位置；仅在 a 的单位取自身值。返回 id → 还原后的单位。
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

/** 在每个原始 tick 上校验还原保真度（位置 ≤ EPS、静态字段精确）。 */
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

describe('StateReplay 关键帧抽稀编解码', () => {
  it('匀速直线行走塌缩为端点（中间帧丢弃，插值还原）', () => {
    // 单位沿 row 匀速移动 0..6，11 帧无状态变化。
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
    // 直线段塌缩：单位关键帧远少于 11（仅端点附近）。
    const unitFrames = enc.frames.filter((df) => df.u?.some((u) => u.id === 1)).length;
    expect(unitFrames).toBeLessThanOrEqual(3);
    expect(enc.frames.length).toBeLessThan(frames.length);
  });

  it('拐点强制落关键帧（L 形路径不被插值抄近道）', () => {
    // t0..5 沿 row 上行；t5..10 沿 col 右行 —— t5 是拐点。
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
    assertFaithful(mkReplay(frames)); // 保真度断言已覆盖拐点（否则 t5 附近误差超 EPS）
  });

  it('状态/血量切换是精确关键帧；死亡产出 ru', () => {
    const frames: StateFrame[] = [
      { tick: 0, units: [{ id: 1, type: 'infantry', side: 0, col: 3, row: 1, hp: 100, maxHp: 100, state: 'moving' }], buildings: [], bases: [{ owner: 0, hp: 100, maxHp: 100 }, { owner: 1, hp: 100, maxHp: 100 }] },
      { tick: 1, units: [{ id: 1, type: 'infantry', side: 0, col: 3, row: 2, hp: 100, maxHp: 100, state: 'moving' }], buildings: [], bases: [{ owner: 0, hp: 100, maxHp: 100 }, { owner: 1, hp: 100, maxHp: 100 }] },
      // t2: 行走→攻击 + 掉血（离散事件，必须精确落帧）
      { tick: 2, units: [{ id: 1, type: 'infantry', side: 0, col: 3, row: 3, hp: 70, maxHp: 100, state: 'attacking' }], buildings: [], bases: [{ owner: 0, hp: 100, maxHp: 100 }, { owner: 1, hp: 100, maxHp: 100 }] },
      // t3: 死亡（消失）
      { tick: 3, units: [], buildings: [], bases: [{ owner: 0, hp: 100, maxHp: 100 }, { owner: 1, hp: 100, maxHp: 100 }] },
    ];
    const enc = assertFaithful(mkReplay(frames));
    // t2 应作为关键帧出现（含新状态/血量）。
    const at2 = enc.frames.find((df) => df.tick === 2);
    expect(at2?.u?.find((u) => u.id === 1)?.state).toBe('attacking');
    expect(at2?.u?.find((u) => u.id === 1)?.hp).toBe(70);
    // 死亡产出 ru。
    expect(enc.frames.some((df) => df.ru?.includes(1))).toBe(true);
  });

  it('建筑变化与基地受损被保留', () => {
    const frames: StateFrame[] = [
      { tick: 0, units: [], buildings: [{ id: 9, type: 'barracks', side: 0, col: 3, row: 0, hp: 200, maxHp: 200 }], bases: [{ owner: 0, hp: 100, maxHp: 100 }, { owner: 1, hp: 100, maxHp: 100 }] },
      { tick: 1, units: [], buildings: [{ id: 9, type: 'barracks', side: 0, col: 3, row: 0, hp: 200, maxHp: 200 }], bases: [{ owner: 0, hp: 100, maxHp: 100 }, { owner: 1, hp: 100, maxHp: 100 }] },
      { tick: 2, units: [], buildings: [{ id: 9, type: 'barracks', side: 0, col: 3, row: 0, hp: 150, maxHp: 200 }], bases: [{ owner: 0, hp: 92, maxHp: 100 }, { owner: 1, hp: 100, maxHp: 100 }] },
    ];
    const dec = decodeStateReplay(encodeStateReplay(mkReplay(frames)));
    // 末帧重建应反映建筑掉血 + 基地受损。
    const last = dec.frames[dec.frames.length - 1]!;
    expect(last.buildings.find((b) => b.id === 9)?.hp).toBe(150);
    // 基地最近一次变化（t2）被记录。
    const enc = encodeStateReplay(mkReplay(frames));
    expect(enc.frames.find((df) => df.tick === 2)?.bs?.find((b) => b.owner === 0)?.hp).toBe(92);
  });

  it('全程静止三帧塌缩为首末（空中间帧丢弃）', () => {
    const stable: StateFrame = {
      tick: 0,
      units: [{ id: 1, type: 'infantry', side: 0, col: 3, row: 1, hp: 100, maxHp: 100, state: 'idle' }],
      buildings: [{ id: 9, type: 'barracks', side: 0, col: 3, row: 0, hp: 200, maxHp: 200 }],
      bases: [{ owner: 0, hp: 100, maxHp: 100 }, { owner: 1, hp: 100, maxHp: 100 }],
    };
    const enc = encodeStateReplay(mkReplay([{ ...stable, tick: 0 }, { ...stable, tick: 1 }, { ...stable, tick: 2 }]));
    // 中间 tick=1 无变化 → 丢弃；只剩首帧（带数据）+ 末帧保底。
    expect(enc.frames.some((df) => df.tick === 1)).toBe(false);
    expect(enc.frames[0]!.tick).toBe(0);
    expect(enc.frames[0]!.u).toBeDefined();
  });

  it('quantizePos rounds to 2 decimals', () => {
    expect(quantizePos(3.14159)).toBe(3.14);
    expect(quantizePos(7.005)).toBeCloseTo(7.01, 5);
  });
});
