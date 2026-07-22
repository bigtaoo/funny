// Client-side mirror of the cumulative recharge milestone table (read-only copy of @nw/shared/rechargeMilestone.ts,
// consumed by RechargeScene). Does not import @nw/shared (the client only depends on pure data inside game/).
// Authoritative numbers = GACHA_DESIGN §13 / ADR-045; update the server-side rechargeMilestone.ts in sync with any changes here.

export type RechargeRewardKind = 'coins' | 'material';

export interface RechargeReward {
  kind: RechargeRewardKind;
  id?: string;
  count: number;
}

export interface RechargeTierDef {
  id: number;
  thresholdCents: number; // cumulative usdCents required
  rewards: RechargeReward[];
}

const coins = (count: number): RechargeReward => ({ kind: 'coins', count });
const lead = (count: number): RechargeReward => ({ kind: 'material', id: 'lead', count });
const binding = (count: number): RechargeReward => ({ kind: 'material', id: 'binding', count });

// DRAFT [adjustable] — keep byte-identical to the server table (server/shared/src/rechargeMilestone.ts).
export const RECHARGE_TIERS: RechargeTierDef[] = [
  { id: 1, thresholdCents: 600, rewards: [coins(60)] },
  { id: 2, thresholdCents: 2000, rewards: [coins(200)] },
  { id: 3, thresholdCents: 5000, rewards: [coins(550), lead(6)] },
  { id: 4, thresholdCents: 10000, rewards: [coins(1200), binding(3)] },
  { id: 5, thresholdCents: 20000, rewards: [coins(2600), binding(6)] },
  { id: 6, thresholdCents: 50000, rewards: [coins(6500), binding(12)] },
  { id: 7, thresholdCents: 100000, rewards: [coins(14000), binding(24)] },
  { id: 8, thresholdCents: 200000, rewards: [coins(30000), binding(48)] },
  { id: 9, thresholdCents: 500000, rewards: [coins(80000), binding(120)] },
];

export function findRechargeTier(id: number): RechargeTierDef | undefined {
  return RECHARGE_TIERS.find((t) => t.id === id);
}
