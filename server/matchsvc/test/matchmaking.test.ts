// Ranked 匹配队列单测（S1-R，搬到 gateway/matchsvc 后）：窗口内立即配、超窗口等待加宽、
// 出队、重复入队覆盖。注入 now() + autoTick:false 手动 tick，不依赖真实定时器。
import { describe, it, expect } from 'vitest';
import { Matchmaking } from '../src/Matchmaking';

describe('Matchmaking', () => {
  it('分差在窗口内立即配对', () => {
    const pairs: [string, string][] = [];
    const mm = new Matchmaking((a, b) => pairs.push([a.accountId, b.accountId]), {
      autoTick: false,
      now: () => 0,
    });
    mm.enqueue('a', 'a', 1000);
    mm.enqueue('b', 'b', 1050); // diff 50 ≤ baseWindow 100
    expect(pairs).toEqual([['a', 'b']]);
    expect(mm.size).toBe(0);
  });

  it('分差超窗口先不配，等待加宽后配对', () => {
    const pairs: [string, string][] = [];
    let t = 0;
    const mm = new Matchmaking((a, b) => pairs.push([a.accountId, b.accountId]), {
      autoTick: false,
      now: () => t,
      baseWindow: 100,
      widenPerSec: 50,
    });
    mm.enqueue('a', 'a', 1000);
    mm.enqueue('b', 'b', 1300); // diff 300 > 100
    expect(pairs).toHaveLength(0);
    t = 5000; // 窗口 100 + 5×50 = 350 ≥ 300
    mm.tick();
    expect(pairs).toEqual([['a', 'b']]);
  });

  it('remove 出队', () => {
    const mm = new Matchmaking(() => {}, { autoTick: false, now: () => 0 });
    mm.enqueue('a', 'a', 1000);
    expect(mm.has('a')).toBe(true);
    mm.remove('a');
    expect(mm.has('a')).toBe(false);
  });

  it('同账号重复入队覆盖，不和自己配对', () => {
    const pairs: unknown[] = [];
    const mm = new Matchmaking((a, b) => pairs.push([a, b]), { autoTick: false, now: () => 0 });
    mm.enqueue('a', 'a', 1000);
    mm.enqueue('a', 'a', 1200);
    expect(mm.size).toBe(1);
    expect(pairs).toHaveLength(0);
  });

  it('三人 → 最近分差两人先配，落单者留队', () => {
    const pairs: [string, string][] = [];
    const mm = new Matchmaking((a, b) => pairs.push([a.accountId, b.accountId]), {
      autoTick: false,
      now: () => 0,
    });
    mm.enqueue('a', 'a', 1000);
    mm.enqueue('b', 'b', 1500);
    mm.enqueue('c', 'c', 1050);
    expect(pairs).toEqual([['a', 'c']]);
    expect(mm.has('b')).toBe(true);
  });
});
