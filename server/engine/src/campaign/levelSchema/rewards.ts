// Split from levelSchema.ts (2026-08-10, independent function module range 6, part 8/8).
import type { LevelRewards } from '../LevelDefinition';
import { fail, int, isObject, str } from './helpers';

export function parseRewards(v: unknown, path: string): LevelRewards | undefined {
  if (v === undefined) return undefined;
  if (!isObject(v)) fail(path, 'expected a rewards object');
  const rewards: LevelRewards = {};
  if (v.coins !== undefined) rewards.coins = int(v.coins, `${path}.coins`);
  if (v.unlockSkinId !== undefined) rewards.unlockSkinId = str(v.unlockSkinId, `${path}.unlockSkinId`);
  if (v.unlockStoryKey !== undefined) {
    rewards.unlockStoryKey = str(v.unlockStoryKey, `${path}.unlockStoryKey`) as LevelRewards['unlockStoryKey'];
  }
  if (v.starThresholds !== undefined) {
    const st = v.starThresholds;
    if (!Array.isArray(st) || st.length !== 3) fail(`${path}.starThresholds`, 'expected a [s1,s2,s3] tuple');
    const t = st.map((x, i) => {
      const n = int(x, `${path}.starThresholds[${i}]`);
      if (n < 0 || n > 100) fail(`${path}.starThresholds[${i}]`, `HP% must be 0..100, got ${n}`);
      return n;
    }) as [number, number, number];
    if (!(t[0] <= t[1] && t[1] <= t[2])) {
      fail(`${path}.starThresholds`, `must be non-decreasing (1★ ≤ 2★ ≤ 3★), got [${t.join(', ')}]`);
    }
    rewards.starThresholds = t;
  }
  if (v.materials !== undefined) {
    if (!isObject(v.materials)) fail(`${path}.materials`, 'expected a material→amount object');
    const mats: Record<string, number> = {};
    for (const [k, amt] of Object.entries(v.materials)) {
      const n = int(amt, `${path}.materials.${k}`);
      if (n < 0) fail(`${path}.materials.${k}`, `must be >= 0, got ${n}`);
      mats[k] = n;
    }
    rewards.materials = mats;
  }
  return rewards;
}
