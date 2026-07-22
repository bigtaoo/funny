// Cumulative recharge milestones (GACHA_DESIGN §13, ADR-045). Pure data + pure functions, no DB / no PIXI.
// Lifetime (never resets) ladder of real-money spend thresholds, unlocking one-off tiered rewards —
// shop-visible progress bar + player-initiated claim (ADR-045; not a silent claimed-on-reach mail drop).
// Progress (totalRechargeCents) is commercial-authoritative (mirrored into SaveData.monetization);
// claim state lives in SaveData.rechargeMilestone, same split as battlepass.ts's xp(SaveData)/claim(SaveData).

export type RechargeRewardKind = 'coins' | 'material';

export interface RechargeReward {
  kind: RechargeRewardKind;
  /** kind=material → material id (scrap/lead/binding). */
  id?: string;
  count: number;
}

export interface RechargeTierDef {
  id: number; // 1-based, stable — do not renumber existing tiers (claimed[] stores these ids)
  thresholdCents: number; // cumulative usdCents required (IAP_TIERS_LIST unit convention)
  rewards: RechargeReward[]; // one tier can grant several items (e.g. coins + a material top-up) in one claim
}

const coins = (count: number): RechargeReward => ({ kind: 'coins', count });
const lead = (count: number): RechargeReward => ({ kind: 'material', id: 'lead', count });
const binding = (count: number): RechargeReward => ({ kind: 'material', id: 'binding', count });

/**
 * Reward ladder (GACHA_DESIGN §13.2). DRAFT [adjustable] — thresholds/rewards are placeholder numbers,
 * owner intends to tune post-launch. thresholdCents in the same usdCents unit as IAP_TIERS_LIST
 * (600 = $6 … 20000 = $200); coins are a bonus on top of whatever the purchase itself already granted.
 */
export const RECHARGE_TIERS: RechargeTierDef[] = [
  { id: 1, thresholdCents: 600, rewards: [coins(60)] },
  { id: 2, thresholdCents: 2000, rewards: [coins(200)] },
  { id: 3, thresholdCents: 5000, rewards: [coins(550), lead(6)] },
  { id: 4, thresholdCents: 10000, rewards: [coins(1200), binding(3)] },
  { id: 5, thresholdCents: 20000, rewards: [coins(2600), binding(6)] },
];

export function findRechargeTier(id: number): RechargeTierDef | undefined {
  return RECHARGE_TIERS.find((t) => t.id === id);
}

/** Recharge milestone claim state (SaveData.rechargeMilestone). Lazily created; absence = no tier ever claimed. */
export interface RechargeMilestoneData {
  claimed: number[]; // tier ids already claimed
}

export function makeFreshRechargeMilestone(): RechargeMilestoneData {
  return { claimed: [] };
}

export type RechargeClaimError =
  | 'NOT_REACHED' // cumulative recharge hasn't reached this tier's threshold
  | 'ALREADY_CLAIMED'
  | 'BAD_REQUEST';

/**
 * Pure function: validates and executes a claim, returning {new claim state, reward} or an error code.
 * `totalRechargeCents` comes from the commercial wallet (read live by the caller, not stored in SaveData).
 * No DB operations; wrapped in an optimistic-lock transaction (mutateSave) by the meta handler.
 */
export function claimRechargeReward(
  data: RechargeMilestoneData,
  totalRechargeCents: number,
  tierId: number,
): { ok: true; data: RechargeMilestoneData; rewards: RechargeReward[] } | { ok: false; error: RechargeClaimError } {
  const def = findRechargeTier(tierId);
  if (!def) return { ok: false, error: 'BAD_REQUEST' };
  if (totalRechargeCents < def.thresholdCents) return { ok: false, error: 'NOT_REACHED' };
  if (data.claimed.includes(tierId)) return { ok: false, error: 'ALREADY_CLAIMED' };
  return { ok: true, data: { claimed: [...data.claimed, tierId] }, rewards: def.rewards };
}
