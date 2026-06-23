// L2-1：赛季收束自动结算闭环单测（无 Mongo，内存 fake cols，风格同 internal.test.ts）。
// 覆盖：
//  - settleSeasonParticipants 主动结算参与者：达标段位发奖励邮件 + 授赛季称号 + 写快照；
//  - 重复 close 同 seasonId 幂等：邮件/称号/快照均不双发（验收「幂等单测」）；
//  - 快照 peakElo/peakRank 与赛季峰值一致；
//  - rollSeason 推进前结算上一季 + CAS 防并发双推。
import { describe, it, expect } from 'vitest';
import {
  makeNewSave,
  ladderTitleId,
  seasonPeakCoins,
  eloToRank,
  type Collections,
  type SaveData,
  type LadderSeasonDoc,
} from '@nw/shared';
import { settleSeasonParticipants, rollSeason } from '../src/ladderSeason.js';
import type { CommercialClient } from '../src/commercialClient.js';

// commercial 在赛季结算路径未被实际调用（金币走邮件附件），桩即可。
const commercial = { available: true } as unknown as CommercialClient;

// ── 内存 fake：支持点号路径查询/写入、$setOnInsert upsert、$addToSet、CAS findOneAndUpdate ──

function getDotted(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}
function setDotted(obj: Record<string, unknown>, path: string, val: unknown): void {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]!] == null) o[keys[i]!] = {};
    o = o[keys[i]!] as Record<string, unknown>;
  }
  o[keys[keys.length - 1]!] = val;
}
function matches(doc: Record<string, unknown>, q: Record<string, unknown>): boolean {
  return Object.entries(q).every(([k, v]) => getDotted(doc, k) === v);
}

class FakeCol {
  docs = new Map<string, Record<string, unknown>>();
  async findOne(q: Record<string, unknown>) {
    if (typeof q._id === 'string' && Object.keys(q).length === 1) return this.docs.get(q._id) ?? null;
    for (const d of this.docs.values()) if (matches(d, q)) return d;
    return null;
  }
  find(q: Record<string, unknown> = {}) {
    const arr = [...this.docs.values()].filter((d) => matches(d, q));
    return {
      async *[Symbol.asyncIterator]() {
        for (const d of arr) yield d;
      },
      toArray: async () => arr,
    };
  }
  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, Record<string, unknown>>,
    opts?: { upsert?: boolean },
  ) {
    let d =
      typeof filter._id === 'string'
        ? this.docs.get(filter._id)
        : [...this.docs.values()].find((x) => matches(x, filter));
    const existed = !!d;
    if (!d) {
      if (!opts?.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      d = { _id: filter._id };
      this.docs.set(filter._id as string, d);
    }
    if (update.$setOnInsert && !existed) Object.assign(d, update.$setOnInsert);
    if (update.$set) for (const [k, v] of Object.entries(update.$set)) setDotted(d, k, v);
    if (update.$addToSet)
      for (const [k, v] of Object.entries(update.$addToSet)) {
        const cur = (getDotted(d, k) as unknown[]) ?? [];
        if (!cur.includes(v)) cur.push(v);
        setDotted(d, k, cur);
      }
    return { matchedCount: existed ? 1 : 0, modifiedCount: 1, upsertedCount: existed ? 0 : 1 };
  }
  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, Record<string, unknown>>,
    opts?: { returnDocument?: 'before' | 'after' },
  ) {
    const d =
      typeof filter._id === 'string'
        ? this.docs.get(filter._id)
        : [...this.docs.values()].find((x) => matches(x, filter));
    if (!d || !matches(d, filter)) return null;
    const before = { ...d };
    if (update.$set) for (const [k, v] of Object.entries(update.$set)) setDotted(d, k, v);
    return opts?.returnDocument === 'before' ? before : d;
  }
  async replaceOne(_filter: Record<string, unknown>, doc: Record<string, unknown>) {
    this.docs.set(doc._id as string, { ...doc });
    return { matchedCount: 1 };
  }
  async countDocuments(q: Record<string, unknown> = {}) {
    return [...this.docs.values()].filter((d) => matches(d, q)).length;
  }
}

interface Fake {
  cols: Collections;
  saves: FakeCol;
  mail: FakeCol;
  ladderSeasons: FakeCol;
  snaps: FakeCol;
}

/** seed: accountId → peak elo（决定段位/奖励）。所有玩家 pvp.seasonNo=1。 */
function makeFake(seed: Record<string, number>): Fake {
  const saves = new FakeCol();
  const mail = new FakeCol();
  const ladderSeasons = new FakeCol();
  const snaps = new FakeCol();
  for (const [id, peakElo] of Object.entries(seed)) {
    const s: SaveData = makeNewSave(id, 1000);
    s.pvp.seasonPeakElo = peakElo;
    s.pvp.seasonPeakRank = eloToRank(peakElo);
    saves.docs.set(id, { _id: id, save: s, rev: s.rev });
  }
  const cols = { saves, mail, ladderSeasons, ladderSeasonSnapshots: snaps } as unknown as Collections;
  return { cols, saves, mail, ladderSeasons, snaps };
}

function titlesOf(f: Fake, id: string): string[] {
  return ((f.saves.docs.get(id)!.save as SaveData).titles ?? []) as string[];
}

describe('settleSeasonParticipants (L2-1 季末闭环)', () => {
  it('结算参与者：达标段位发奖励邮件 + 授赛季称号 + 写快照', async () => {
    const f = makeFake({ alice: 1900 /* master */, bob: 1000 /* bronze */ });
    const res = await settleSeasonParticipants(f.cols, commercial, 1, 100);

    expect(res).toEqual({ settled: 2, rewarded: 1 }); // 仅 master 有金币

    // 称号：双方都授予对应段位赛季称号（幂等 $addToSet）
    expect(titlesOf(f, 'alice')).toContain(ladderTitleId(1, 'master'));
    expect(titlesOf(f, 'bob')).toContain(ladderTitleId(1, 'bronze'));

    // 邮件：仅 master 收到（bronze 金币 0 不发邮件）
    expect(await f.mail.countDocuments()).toBe(1);
    const mailDoc = (await f.mail.find().toArray())[0] as Record<string, unknown>;
    expect(mailDoc._id).toBe('ladder.season.1.alice:alice');

    // 快照：双方各一条，peakElo/peakRank 与赛季峰值一致
    expect(await f.snaps.countDocuments()).toBe(2);
    const aliceSnap = f.snaps.docs.get('1:alice')!;
    expect(aliceSnap).toMatchObject({
      seasonNo: 1,
      accountId: 'alice',
      peakElo: 1900,
      peakRank: 'master',
      coins: seasonPeakCoins('master'),
      titleId: ladderTitleId(1, 'master'),
    });
    const bobSnap = f.snaps.docs.get('1:bob')!;
    expect(bobSnap).toMatchObject({ peakElo: 1000, peakRank: 'bronze', coins: 0 });
  });

  it('重复 close 同 seasonId 幂等：邮件/称号/快照均不双发', async () => {
    const f = makeFake({ alice: 1900 });
    await settleSeasonParticipants(f.cols, commercial, 1, 100);
    await settleSeasonParticipants(f.cols, commercial, 1, 200); // 再跑一次同季

    expect(await f.mail.countDocuments()).toBe(1); // 邮件 dispatchKey 去重
    expect(titlesOf(f, 'alice')).toEqual([ladderTitleId(1, 'master')]); // 称号无重复
    expect(await f.snaps.countDocuments()).toBe(1); // 快照 _id 复合键去重
    expect(f.snaps.docs.get('1:alice')!.ts).toBe(100); // $setOnInsert 不覆写首次结算
  });
});

describe('rollSeason (L2-1 收束并开新季)', () => {
  it('推进前结算上一季全部参与者，再把时钟推进到下一季', async () => {
    const f = makeFake({ alice: 1900 });
    f.ladderSeasons.docs.set('current', {
      _id: 'current',
      seasonNo: 1,
      startAt: 0,
      endAt: 1000,
      state: 'active',
    } satisfies LadderSeasonDoc as unknown as Record<string, unknown>);

    const next = await rollSeason(f.cols, commercial, 5000);

    expect(next.seasonNo).toBe(2);
    expect(next.state).toBe('active');
    // 上一季（1）已结算
    expect(titlesOf(f, 'alice')).toContain(ladderTitleId(1, 'master'));
    expect(await f.mail.countDocuments()).toBe(1);
    expect(await f.snaps.countDocuments()).toBe(1);
  });

  it('CAS 防并发双推：state 非 active 时不重复推进', async () => {
    const f = makeFake({ alice: 1900 });
    f.ladderSeasons.docs.set('current', {
      _id: 'current',
      seasonNo: 3,
      startAt: 0,
      endAt: 1000,
      state: 'settling', // 已在结算中
    } satisfies LadderSeasonDoc as unknown as Record<string, unknown>);

    const r = await rollSeason(f.cols, commercial, 5000);
    expect(r.seasonNo).toBe(3); // 原样返回，不推进
    expect(await f.snaps.countDocuments()).toBe(0); // 未结算
  });
});
