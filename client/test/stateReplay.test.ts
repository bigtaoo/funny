// 状态流录像 delta 编解码 round-trip（REPLAY_SHARE_DESIGN §6）。
// 满帧序列 → encode → decode 应逐帧深等（含新增/移动/掉血/死亡/建筑摧毁/基地受损）。
import { describe, it, expect } from 'vitest';
import {
  encodeStateReplay,
  decodeStateReplay,
  quantizePos,
  STATE_SCHEMA_VERSION,
  type StateReplay,
  type StateFrame,
} from '../src/game/replay/StateReplay';

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

describe('StateReplay delta codec', () => {
  it('round-trips a multi-frame match exactly', () => {
    const frames: StateFrame[] = [
      // t0: 一个单位 + 一座建筑 + 双基地满血
      {
        tick: 0,
        units: [{ id: 1000, type: 'infantry', side: 0, col: 3, row: 1, hp: 100, maxHp: 100, state: 'moving' }],
        buildings: [{ id: 1, type: 'barracks', side: 0, col: 3, row: 0, hp: 200, maxHp: 200 }],
        bases: [
          { owner: 0, hp: 100, maxHp: 100 },
          { owner: 1, hp: 100, maxHp: 100 },
        ],
      },
      // t1: 单位移动 + 第二个单位出生（top）
      {
        tick: 1,
        units: [
          { id: 1000, type: 'infantry', side: 0, col: 3, row: 2.5, hp: 100, maxHp: 100, state: 'moving' },
          { id: 1001, type: 'archer', side: 1, col: 3, row: 15, hp: 60, maxHp: 60, state: 'moving' },
        ],
        buildings: [{ id: 1, type: 'barracks', side: 0, col: 3, row: 0, hp: 200, maxHp: 200 }],
        bases: [
          { owner: 0, hp: 100, maxHp: 100 },
          { owner: 1, hp: 100, maxHp: 100 },
        ],
      },
      // t2: 互相掉血 + 基地受损
      {
        tick: 2,
        units: [
          { id: 1000, type: 'infantry', side: 0, col: 3, row: 7, hp: 70, maxHp: 100, state: 'attacking' },
          { id: 1001, type: 'archer', side: 1, col: 3, row: 8, hp: 20, maxHp: 60, state: 'attacking' },
        ],
        buildings: [{ id: 1, type: 'barracks', side: 0, col: 3, row: 0, hp: 180, maxHp: 200 }],
        bases: [
          { owner: 0, hp: 95, maxHp: 100 },
          { owner: 1, hp: 100, maxHp: 100 },
        ],
      },
      // t3: archer 死亡 + 建筑摧毁
      {
        tick: 3,
        units: [{ id: 1000, type: 'infantry', side: 0, col: 3, row: 9, hp: 70, maxHp: 100, state: 'moving' }],
        buildings: [],
        bases: [
          { owner: 0, hp: 95, maxHp: 100 },
          { owner: 1, hp: 88, maxHp: 100 },
        ],
      },
    ];

    const original = mkReplay(frames);
    const decoded = decodeStateReplay(encodeStateReplay(original));

    expect(decoded.header).toEqual(original.header);
    expect(decoded.frames).toEqual(original.frames);
  });

  it('omits unchanged entities in the delta stream (compression actually fires)', () => {
    const stable: StateFrame = {
      tick: 0,
      units: [{ id: 1000, type: 'infantry', side: 0, col: 3, row: 1, hp: 100, maxHp: 100, state: 'moving' }],
      buildings: [{ id: 1, type: 'barracks', side: 0, col: 3, row: 0, hp: 200, maxHp: 200 }],
      bases: [
        { owner: 0, hp: 100, maxHp: 100 },
        { owner: 1, hp: 100, maxHp: 100 },
      ],
    };
    // 三帧完全相同：仅首帧带数据，后两帧 delta 应为空（只剩 tick）。
    const original = mkReplay([
      { ...stable, tick: 0 },
      { ...stable, tick: 1 },
      { ...stable, tick: 2 },
    ]);
    const enc = encodeStateReplay(original);
    expect(enc.frames[0]!.u).toBeDefined();
    expect(enc.frames[1]!.u).toBeUndefined();
    expect(enc.frames[1]!.bs).toBeUndefined();
    expect(enc.frames[2]!.ru).toBeUndefined();
    // 解码仍还原满帧。
    expect(decodeStateReplay(enc).frames[2]).toEqual(original.frames[2]);
  });

  it('quantizePos rounds to 2 decimals', () => {
    expect(quantizePos(3.14159)).toBe(3.14);
    expect(quantizePos(7.005)).toBeCloseTo(7.01, 5);
  });
});
