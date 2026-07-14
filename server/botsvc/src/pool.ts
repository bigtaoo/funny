// Bot account pool (BOTSVC_DESIGN §3.1, §5): deviceId per bot + a payment tier assigned once at pool-generation
// time and never changed (real paying habits don't flip daily either).
export type PaymentTier = 'free' | 'monthly_card' | 'starter_growth';

export interface BotIdentity {
  /** `bot-0001`..`bot-NNNN`; also used as the deviceId for metaserver's anonymous device-login (min length 8). */
  deviceId: string;
  paymentTier: PaymentTier;
}

/** 50% free / 30% monthly card / 20% one-time growth pack (user-specified split, §5). Order matters: checked in sequence. */
const TIER_THRESHOLDS: Array<{ upTo: number; tier: PaymentTier }> = [
  { upTo: 0.5, tier: 'free' },
  { upTo: 0.8, tier: 'monthly_card' },
  { upTo: 1.0, tier: 'starter_growth' },
];

function tierForRatio(ratio: number): PaymentTier {
  for (const { upTo, tier } of TIER_THRESHOLDS) {
    if (ratio < upTo) return tier;
  }
  return 'starter_growth';
}

/**
 * Deterministic pool generation: same size always yields the same deviceId→tier assignment (no RNG),
 * so restarting botsvc doesn't reshuffle who owns which purchase history.
 */
export function generateBotPool(size: number, deviceOffset = 0): BotIdentity[] {
  const pool: BotIdentity[] = [];
  for (let i = 1; i <= size; i++) {
    // Offset only shifts the deviceId (account identity); the tier split stays keyed to the in-pool
    // index so a given slot keeps its purchase profile regardless of where the numbering starts.
    const deviceId = `bot-${String(i + deviceOffset).padStart(4, '0')}`;
    const ratio = (i - 0.5) / size;
    pool.push({ deviceId, paymentTier: tierForRatio(ratio) });
  }
  return pool;
}
