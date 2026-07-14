import { describe, it, expect } from 'vitest';
import { generateBotPool } from '../src/pool';

describe('generateBotPool', () => {
  it('splits 1000 bots 50/30/20 free/monthly/starter', () => {
    const pool = generateBotPool(1000);
    const counts = { free: 0, monthly_card: 0, starter_growth: 0 };
    for (const b of pool) counts[b.paymentTier]++;
    expect(counts.free).toBe(500);
    expect(counts.monthly_card).toBe(300);
    expect(counts.starter_growth).toBe(200);
  });

  it('deviceId is deterministic and satisfies metaserver minLength 8', () => {
    const pool = generateBotPool(5);
    expect(pool[0]!.deviceId).toBe('bot-0001');
    for (const b of pool) expect(b.deviceId.length).toBeGreaterThanOrEqual(8);
  });

  it('is deterministic across calls (no RNG reshuffle on restart)', () => {
    expect(generateBotPool(1000)).toEqual(generateBotPool(1000));
  });
});
