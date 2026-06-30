// ─────────────────────────────────────────────────────────────────────────────
// A-track aggregation model (SLG_ECONOMY_CHECK §2.2 / §2.3)
//
// Per-head settle payout: rewards go to EVERY member of a ranked sect (per-head, the
// pinned 2026-06-30 granularity), so `participant` head count dominates total volume.
// We aggregate one SLG season server-wide across shards, both views:
//   · per-head  (养成稀释 / head-tilt)
//   · server-wide (全服通胀, against material faucet AND coin faucet)
// ─────────────────────────────────────────────────────────────────────────────

import {
  SETTLE_REWARDS,
  CENTER_CAPITAL_MULT,
  WORLD_CAPACITY,
  type SettleTier,
} from '@nw/shared';
import {
  MATERIALS,
  type MaterialKey,
  bundleCoinValue,
  MATERIAL_COIN_VALUE,
  REGULAR_MONTHLY_MATERIAL,
  REGULAR_MONTHLY_MATERIAL_COINS,
  MONTHLY_COIN_FAUCET_PER_PLAYER,
} from './valuation';

const TIERS: SettleTier[] = ['champion', 'top3', 'top10', 'participant'];
/** How many sects occupy each tier per shard (rank buckets, §2.2). */
const SECTS_PER_TIER: Record<Exclude<SettleTier, 'participant'>, number> = {
  champion: 1, // rank 1
  top3: 2, //     ranks 2..3
  top10: 7, //    ranks 4..10
};

export interface Scenario {
  name: string;
  note?: string;
  population: number; // server-wide SLG active accounts
  worldCapacity?: number; // default WORLD_CAPACITY
  /** Members in each winning sect (winners tend to be large; per-head total lever). */
  topSectMembers: { champion: number; top3: number; top10: number };
  /** Fraction of a tier's heads whose sect holds the central capital (idx 9) -> ×CENTER_CAPITAL_MULT. */
  capitalHoldRate: Record<SettleTier, number>;
  /** §0.1 细水: daily/event material per active player per day (small, but counted). */
  dailyMaterialPerActive: Partial<Record<MaterialKey, number>>;
  seasonDays: number;
}

export interface TierResult {
  tier: SettleTier;
  headsPerShard: number;
  headsServerWide: number;
  /** Effective per-head material (capital ×2 blended by hold rate). */
  perHeadMaterial: Record<MaterialKey, number>;
  perHeadSeasonCoins: number;
  perHeadMonthlyCoins: number;
  serverWideMaterial: Record<MaterialKey, number>;
  serverWideSeasonCoins: number;
}

export interface SimResult {
  scenario: Scenario;
  shardCount: number;
  seasonMonths: number;
  tiers: TierResult[];
  // server-wide season totals (settle + 细水)
  serverWideMaterial: Record<MaterialKey, number>;
  trickleMaterial: Record<MaterialKey, number>;
  serverWideSeasonCoins: number;
  serverWideMonthlyCoins: number;
  // denominators
  grindMaterialServerSeason: Record<MaterialKey, number>;
  grindCoinsServerMonthly: number;
  coinFaucetServerMonthly: number;
}

function emptyMat(): Record<MaterialKey, number> {
  return { scrap: 0, lead: 0, binding: 0 };
}

/** Blended capital multiplier for a tier: (1 - rate) ×1 + rate ×CENTER_CAPITAL_MULT. */
function capitalMult(rate: number): number {
  const r = Math.max(0, Math.min(1, rate));
  return 1 + r * (CENTER_CAPITAL_MULT - 1);
}

export function runScenario(s: Scenario): SimResult {
  const cap = s.worldCapacity ?? WORLD_CAPACITY;
  const shardCount = Math.max(1, Math.ceil(s.population / cap));
  const seasonMonths = s.seasonDays / 30;
  // Distribute population evenly across shards (last shard absorbs remainder).
  const popPerShard = s.population / shardCount;

  const tiers: TierResult[] = [];
  const serverWideMaterial = emptyMat();

  for (const tier of TIERS) {
    let headsPerShard: number;
    if (tier === 'participant') {
      const topHeads =
        SECTS_PER_TIER.champion * s.topSectMembers.champion +
        SECTS_PER_TIER.top3 * s.topSectMembers.top3 +
        SECTS_PER_TIER.top10 * s.topSectMembers.top10;
      headsPerShard = Math.max(0, popPerShard - topHeads);
    } else {
      headsPerShard = SECTS_PER_TIER[tier] * s.topSectMembers[tier];
    }
    const headsServerWide = headsPerShard * shardCount;
    const mult = capitalMult(s.capitalHoldRate[tier] ?? 0);
    const reward = SETTLE_REWARDS[tier];

    const perHeadMaterial = emptyMat();
    const tierServerWide = emptyMat();
    for (const mat of MATERIALS) {
      const base = reward.items[mat] ?? 0;
      perHeadMaterial[mat] = base * mult;
      tierServerWide[mat] = perHeadMaterial[mat] * headsServerWide;
      serverWideMaterial[mat] += tierServerWide[mat];
    }
    const perHeadSeasonCoins = bundleCoinValue(perHeadMaterial);
    tiers.push({
      tier,
      headsPerShard,
      headsServerWide,
      perHeadMaterial,
      perHeadSeasonCoins,
      perHeadMonthlyCoins: perHeadSeasonCoins / seasonMonths,
      serverWideMaterial: tierServerWide,
      serverWideSeasonCoins: bundleCoinValue(tierServerWide),
    });
  }

  // §0.1 细水 (daily/event) — applies to all active players, counted in A-track.
  const trickleMaterial = emptyMat();
  for (const mat of MATERIALS) {
    const perDay = s.dailyMaterialPerActive[mat] ?? 0;
    trickleMaterial[mat] = perDay * s.seasonDays * s.population;
    serverWideMaterial[mat] += trickleMaterial[mat];
  }

  const serverWideSeasonCoins = bundleCoinValue(serverWideMaterial);
  const serverWideMonthlyCoins = serverWideSeasonCoins / seasonMonths;

  // Denominators (§2.3): material grind faucet (correct, same units) + coin faucet (cross-ref).
  const grindMaterialServerSeason = emptyMat();
  for (const mat of MATERIALS) {
    grindMaterialServerSeason[mat] = REGULAR_MONTHLY_MATERIAL[mat] * seasonMonths * s.population;
  }
  const grindCoinsServerMonthly = REGULAR_MONTHLY_MATERIAL_COINS * s.population;
  const coinFaucetServerMonthly = MONTHLY_COIN_FAUCET_PER_PLAYER * s.population;

  return {
    scenario: s,
    shardCount,
    seasonMonths,
    tiers,
    serverWideMaterial,
    trickleMaterial,
    serverWideSeasonCoins,
    serverWideMonthlyCoins,
    grindMaterialServerSeason,
    grindCoinsServerMonthly,
    coinFaucetServerMonthly,
  };
}

// ── §2.3 judgments ──────────────────────────────────────────────────────────
export interface Judgment {
  key: string;
  view: 'per-head' | 'server' | '—';
  detail: string;
  value: number; // primary ratio (fraction or multiple)
  threshold: number;
  pass: boolean;
  /** Informational only — reported but does NOT gate the core verdict (see §13-SLG notes). */
  informational?: boolean;
}

export const THRESHOLDS = {
  perHeadDilution: 0.15, // participant settle monthly <= 15% of regular monthly material (GATING)
  serverInflation: 0.1, //  settle server monthly coin-eq <= 10% of MATERIAL faucet (GATING)
  headTilt: 10, //          champion per-head <= 10x participant — INFORMATIONAL only (downgraded 2026-06-30)
};

function pct(n: number): string {
  return (n * 100).toFixed(2) + '%';
}

export function judge(r: SimResult): Judgment[] {
  const out: Judgment[] = [];
  const part = r.tiers.find((t) => t.tier === 'participant')!;
  const champ = r.tiers.find((t) => t.tier === 'champion')!;

  // 1. 人均稀释 (participant, material vs grind, same units)
  const partMonthly = part.perHeadMonthlyCoins;
  const dilution = partMonthly / REGULAR_MONTHLY_MATERIAL_COINS;
  out.push({
    key: '人均稀释 (participant)',
    view: 'per-head',
    detail: `participant ${partMonthly.toFixed(0)} coin-eq/mo vs grind ${REGULAR_MONTHLY_MATERIAL_COINS.toFixed(0)}/mo = ${pct(dilution)}`,
    value: dilution,
    threshold: THRESHOLDS.perHeadDilution,
    pass: dilution <= THRESHOLDS.perHeadDilution,
  });

  // 1b. 人均稀释 (champion, worst case head)
  const champDilution = champ.perHeadMonthlyCoins / REGULAR_MONTHLY_MATERIAL_COINS;
  out.push({
    key: '人均稀释 (champion, 最坏头)',
    view: 'per-head',
    detail: `champion ${champ.perHeadMonthlyCoins.toFixed(0)} coin-eq/mo vs grind ${REGULAR_MONTHLY_MATERIAL_COINS.toFixed(0)}/mo = ${pct(champDilution)}`,
    value: champDilution,
    threshold: THRESHOLDS.perHeadDilution,
    pass: champDilution <= THRESHOLDS.perHeadDilution,
  });

  // 2. 全服通胀 — CORRECT denominator: material grind faucet (same units, fungible)
  const inflMat = r.serverWideMonthlyCoins / r.grindCoinsServerMonthly;
  out.push({
    key: '全服通胀 (vs 材料龙头·正确口径)',
    view: 'server',
    detail: `settle ${(r.serverWideMonthlyCoins / 1e6).toFixed(2)}M coin-eq/mo vs material grind ${(r.grindCoinsServerMonthly / 1e6).toFixed(2)}M/mo = ${pct(inflMat)}`,
    value: inflMat,
    threshold: THRESHOLDS.serverInflation,
    pass: inflMat <= THRESHOLDS.serverInflation,
  });

  // 2b. 全服通胀 — literal §2.3 reading vs COIN faucet (flagged: category cross-ref, settle injects 0 coins)
  const inflCoin = r.serverWideMonthlyCoins / r.coinFaucetServerMonthly;
  out.push({
    key: '全服通胀 (vs 金币龙头·跨类参考)',
    view: 'server',
    detail: `settle ${(r.serverWideMonthlyCoins / 1e6).toFixed(2)}M coin-eq/mo vs coin faucet ${(r.coinFaucetServerMonthly / 1e6).toFixed(2)}M/mo = ${pct(inflCoin)} — settle 实发 coins=0, 此口径为名义换算 (见 §13-SLG 注)`,
    value: inflCoin,
    threshold: THRESHOLDS.serverInflation,
    pass: inflCoin <= THRESHOLDS.serverInflation,
    informational: true,
  });

  // 3. coin 子项 — every tier must keep coins = 0 (红线 1)
  const totalSettleCoins = TIERS.reduce((a, t) => a + (SETTLE_REWARDS[t].coins ?? 0), 0);
  out.push({
    key: 'coin 子项',
    view: '—',
    detail: `Σ SETTLE_REWARDS[*].coins = ${totalSettleCoins} (须 = 0 否则走 §2.4 签字)`,
    value: totalSettleCoins,
    threshold: 0,
    pass: totalSettleCoins === 0,
  });

  // 4. 头部倾斜 (per-head): champion / participant — INFORMATIONAL (decided 2026-06-30).
  // Downgraded to non-gating: per-head, the structural guardrail is champion ABSOLUTE
  // dilution (judgment 1b, <=15% PASS), not the gradient. The ratio is structurally large
  // because participant binding=0 while champion binding>0 — intended "winners get more".
  const tilt = part.perHeadSeasonCoins > 0 ? champ.perHeadSeasonCoins / part.perHeadSeasonCoins : Infinity;
  out.push({
    key: '头部倾斜 (champion/participant 人均, 非门控)',
    view: 'per-head',
    detail: `champion ${champ.perHeadSeasonCoins.toFixed(0)} / participant ${part.perHeadSeasonCoins.toFixed(0)} coin-eq = ${tilt.toFixed(1)}× — 护栏改由 champion 绝对稀释 (判据 1b) 承担, 梯度本身不设硬墙`,
    value: tilt,
    threshold: THRESHOLDS.headTilt,
    pass: tilt <= THRESHOLDS.headTilt,
    informational: true,
  });

  return out;
}

export { MATERIAL_COIN_VALUE };
