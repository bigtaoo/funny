// L1 抽检触发纯函数（PVE_INTEGRITY §8.6 第 3 步）：首通 / 蓝图异常恒触发；其余按比例随机抽检。
import { describe, it, expect } from 'vitest';
import { shouldSpotCheck, PVE_VERIFY_SAMPLE_RATE } from '@nw/shared';

describe('shouldSpotCheck', () => {
  it('首通恒触发（不看随机）', () => {
    expect(shouldSpotCheck({ isFirstClear: true, blueprintMismatch: false, rand: 0.99 })).toBe(true);
  });

  it('蓝图异常恒触发（开局战力不符 → 必查）', () => {
    expect(shouldSpotCheck({ isFirstClear: false, blueprintMismatch: true, rand: 0.99 })).toBe(true);
  });

  it('重复刷：随机数 < 抽检率才触发', () => {
    const base = { isFirstClear: false, blueprintMismatch: false };
    expect(shouldSpotCheck({ ...base, rand: PVE_VERIFY_SAMPLE_RATE - 0.001 })).toBe(true);
    expect(shouldSpotCheck({ ...base, rand: PVE_VERIFY_SAMPLE_RATE + 0.001 })).toBe(false);
  });

  it('自定义抽检率覆盖默认', () => {
    const base = { isFirstClear: false, blueprintMismatch: false };
    expect(shouldSpotCheck({ ...base, rand: 0.5, sampleRate: 1 })).toBe(true);
    expect(shouldSpotCheck({ ...base, rand: 0.5, sampleRate: 0 })).toBe(false);
  });
});
