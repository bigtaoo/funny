// Ranked 端到端（S1-R，无真 Mongo）：匹配 → 开局 → 局末结算写 saves.pvp。
// 用内存 fake 的 saves 集合驱动 RoomManager.settleRanked / applyPvp。
import { describe, it, expect } from 'vitest';
import { InMemoryRoomRegistry, makeNewSave, type Collections, type SaveData } from '@nw/shared';
import type { Connection } from '../src/Connection';
import { RoomManager } from '../src/RoomManager';
import { MatchMode, type ServerMsg } from '../src/proto/transport';

const flush = (): Promise<void> => new Promise((res) => setTimeout(res, 0));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await flush();
};

interface FakeConn {
  accountId: string;
  roomId: string | null;
  alive: boolean;
  outbox: ServerMsg[];
  closed: { code: number; reason: string } | null;
  send(msg: ServerMsg): void;
  close(code: number, reason: string): void;
}
function makeConn(accountId: string): FakeConn {
  return {
    accountId,
    roomId: null,
    alive: true,
    outbox: [],
    closed: null,
    send(msg) {
      this.outbox.push(msg);
    },
    close(code, reason) {
      this.closed = { code, reason };
    },
  };
}
const asConn = (c: FakeConn): Connection => c as unknown as Connection;
const find = <T extends ServerMsg['case']>(
  c: FakeConn,
  kase: T,
): Extract<ServerMsg, { case: T }> | undefined =>
  c.outbox.find((m) => m.case === kase) as Extract<ServerMsg, { case: T }> | undefined;

/** 内存 saves 集合：findOne + 乐观锁 findOneAndUpdate（rev 守卫）。 */
function fakeMongo(seed: Record<string, SaveData>) {
  const saves = new Map<string, { _id: string; save: SaveData; rev: number }>();
  for (const [id, s] of Object.entries(seed)) saves.set(id, { _id: id, save: s, rev: s.rev });
  const matches: unknown[] = [];
  const cols = {
    saves: {
      findOne: async (q: { _id: string }) => saves.get(q._id) ?? null,
      findOneAndUpdate: async (
        filter: { _id: string; rev: number },
        update: { $set: { save: SaveData; rev: number } },
      ) => {
        const d = saves.get(filter._id);
        if (!d || d.rev !== filter.rev) return null; // rev 不匹配 → 冲突
        const next = { _id: d._id, save: update.$set.save, rev: update.$set.rev };
        saves.set(d._id, next);
        return next;
      },
    },
    matches: {
      insertOne: async (doc: unknown) => {
        matches.push(doc);
        return {};
      },
    },
  } as unknown as Collections;
  return { cols, saves, matches };
}

/** 把两个连接送进 ranked 匹配并开局；返回 side0/side1 对应的连接。 */
async function startRanked(
  mgr: RoomManager,
  c0: FakeConn,
  c1: FakeConn,
): Promise<{ side0: FakeConn; side1: FakeConn }> {
  mgr.register(asConn(c0));
  mgr.register(asConn(c1));
  mgr.handle(asConn(c0), { case: 'room_create', mode: MatchMode.RANKED });
  await flush();
  mgr.handle(asConn(c1), { case: 'room_create', mode: MatchMode.RANKED });
  await settle();
  const ms0 = find(c0, 'match_start');
  const ms1 = find(c1, 'match_start');
  if (!ms0 || !ms1) throw new Error('match_start not delivered');
  const side0 = ms0.localSide === 0 ? c0 : c1;
  const side1 = ms0.localSide === 0 ? c1 : c0;
  return { side0, side1 };
}

describe('ranked (S1-R)', () => {
  it('无 Mongo → RANKED_UNAVAILABLE（天梯需服务器存储）', async () => {
    const mgr = new RoomManager(new InMemoryRoomRegistry(), null);
    const c0 = makeConn('a');
    mgr.register(asConn(c0));
    mgr.handle(asConn(c0), { case: 'room_create', mode: MatchMode.RANKED });
    await flush();
    expect(find(c0, 'room_error')?.code).toBe('RANKED_UNAVAILABLE');
    expect(c0.roomId).toBeNull();
  });

  it('匹配→开局→双方一致结果→ELO 结算写 saves.pvp', async () => {
    const { cols, saves } = fakeMongo({ a: makeNewSave('a', 0), b: makeNewSave('b', 0) });
    const mgr = new RoomManager(new InMemoryRoomRegistry(), cols);
    const c0 = makeConn('a');
    const c1 = makeConn('b');
    const { side0, side1 } = await startRanked(mgr, c0, c1);

    // 双方同 seed
    expect(find(c0, 'match_start')!.seed).toBe(find(c1, 'match_start')!.seed);

    // side0 胜，双方 hash + winner 一致
    mgr.handle(asConn(side0), { case: 'match_result', stateHash: 'h', winnerSide: 0 });
    mgr.handle(asConn(side1), { case: 'match_result', stateHash: 'h', winnerSide: 0 });
    await settle();

    const mo0 = find(side0, 'match_over')!;
    const mo1 = find(side1, 'match_over')!;
    expect(mo0.winnerSide).toBe(0);
    expect(mo0.mismatch).toBe(false);
    // 同分对局 K=32 → ±16
    expect(mo0.elo).toEqual({ delta: 16, after: 1016, rankAfter: 'bronze' });
    expect(mo1.elo).toEqual({ delta: -16, after: 984, rankAfter: 'bronze' });

    const winId = side0.accountId;
    const loseId = side1.accountId;
    expect(saves.get(winId)!.save.pvp).toMatchObject({ elo: 1016, wins: 1, losses: 0, streak: 1 });
    expect(saves.get(loseId)!.save.pvp).toMatchObject({ elo: 984, wins: 0, losses: 1, streak: -1 });
  });

  it('hash 不一致 → 作废，不动 ELO', async () => {
    const { cols, saves } = fakeMongo({ a: makeNewSave('a', 0), b: makeNewSave('b', 0) });
    const mgr = new RoomManager(new InMemoryRoomRegistry(), cols);
    const { side0, side1 } = await startRanked(mgr, makeConn('a'), makeConn('b'));

    mgr.handle(asConn(side0), { case: 'match_result', stateHash: 'h1', winnerSide: 0 });
    mgr.handle(asConn(side1), { case: 'match_result', stateHash: 'h2', winnerSide: 0 });
    await settle();

    const mo = find(side0, 'match_over')!;
    expect(mo.mismatch).toBe(true);
    expect(mo.elo).toBeUndefined();
    expect(saves.get('a')!.save.pvp.elo).toBe(1000);
    expect(saves.get('b')!.save.pvp.elo).toBe(1000);
  });

  it('认输（对局中 leave）→ 对手判胜 + ELO', async () => {
    const { cols, saves } = fakeMongo({ a: makeNewSave('a', 0), b: makeNewSave('b', 0) });
    const mgr = new RoomManager(new InMemoryRoomRegistry(), cols);
    const { side0, side1 } = await startRanked(mgr, makeConn('a'), makeConn('b'));

    mgr.handle(asConn(side0), { case: 'room_leave' }); // side0 认输
    await settle();

    const mo1 = find(side1, 'match_over')!;
    expect(mo1.reason).toBe('disconnect');
    expect(mo1.winnerSide).toBe(1);
    expect(mo1.elo!.delta).toBeGreaterThan(0);
    expect(saves.get(side1.accountId)!.save.pvp.wins).toBe(1);
    expect(saves.get(side0.accountId)!.save.pvp.losses).toBe(1);
  });
});
