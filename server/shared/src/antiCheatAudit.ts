// 成就 PvP 统计反作弊 L2/L3 的「纯逻辑」实现（机制权威 ACHIEVEMENT_DESIGN.md §4.4）。
// 纯数据 + 纯函数（随机/时钟外部注入），无 DB；meta 离线抽查批（anticheatAudit.ts）调用。
//
// L2 随机抽查：以基础概率 p0 抽取已归档 ranked 局，经在线 peer 裁判无头复算真实 kill/cast，
// 与上报值比对。L3 作弊者升档：曾被实锤过造假（statSuspicion>0）的账号抽查概率抬到 p_flagged。
import type { StatKey } from './achievements';
import { PVP_REPORTED_STAT_KEYS, accrueStats } from './achievements';
import type { SaveData } from './types';

/** L2 基础抽查概率（clean 账号，§4.4）。粗放低成本兜底，不为小金币池上重型复算。 */
export const AUDIT_SAMPLE_P0 = 0.02;
/** L3 升档抽查概率（statSuspicion>0 的账号，§4.4）。命中过造假 → 长期高抽查档位。 */
export const AUDIT_SAMPLE_P_FLAGGED = 0.35;

export interface AuditSampleOpts {
  p0?: number;
  pFlagged?: number;
}

/**
 * 该账号当前的抽查概率（§4.4 L3 升档）：曾被实锤造假（statSuspicion>0）→ p_flagged，否则 p0。
 * 一局取参战双方 statSuspicion 的较大值喂入（任一方 flagged 即抬高整局被抽概率）。
 */
export function auditSampleProbability(statSuspicion: number, opts?: AuditSampleOpts): number {
  const p0 = opts?.p0 ?? AUDIT_SAMPLE_P0;
  const pFlagged = opts?.pFlagged ?? AUDIT_SAMPLE_P_FLAGGED;
  return statSuspicion > 0 ? pFlagged : p0;
}

/** 是否抽查该局（随机数外部注入，便于测试确定性）。rand < 概率 → 抽中。 */
export function shouldAuditSample(
  statSuspicion: number,
  rand: number,
  opts?: AuditSampleOpts,
): boolean {
  return rand < auditSampleProbability(statSuspicion, opts);
}

export interface AuditComparison {
  /** 超报量（`max(0, reported-authoritative)` 逐 statKey，省略 0；少报/相等不计）。 */
  overclaim: Partial<Record<StatKey, number>>;
  /** 是否存在任一超报（→ 实锤造假，触发回滚 + 升档）。 */
  suspicious: boolean;
}

/**
 * 比对某方上报值与裁判复算的权威值（§4.4 L2）。
 * **只看超报**：reported > authoritative 才计（玩家少报只亏自己、不追溯；金币已发不追回，
 * 故 under-claim/相等 = clean）。只遍历 {@link PVP_REPORTED_STAT_KEYS}（pvp.wins 服务器自算、
 * campaign.* 是 PvE，均不审计）。
 */
export function compareAudit(
  reported: Partial<Record<StatKey, number>> | undefined,
  authoritative: Partial<Record<StatKey, number>> | undefined,
): AuditComparison {
  const overclaim: Partial<Record<StatKey, number>> = {};
  let suspicious = false;
  for (const k of PVP_REPORTED_STAT_KEYS) {
    const r = reported?.[k] ?? 0;
    const a = authoritative?.[k] ?? 0;
    const over = r - a;
    if (over > 0) {
      overclaim[k] = over;
      suspicious = true;
    }
  }
  return { overclaim, suspicious };
}

/**
 * 把超报量从玩家终身 stats 扣回（§4.4 回滚）：逐 statKey 扣减按当前值 0 下限钳制
 * （扣减量 = `min(overclaim[k], 当前值)`）。返回新 stats + 实际扣减量（理论 overclaim 可大于实际，
 * 供审查记录区分）。纯函数：无增量则原样返回 prev、不实例化（懒创建）。
 */
export function applyRollback(
  prev: SaveData['stats'],
  overclaim: Partial<Record<StatKey, number>>,
): { stats: SaveData['stats']; rolledBack: Partial<Record<StatKey, number>> } {
  const rolledBack: Partial<Record<StatKey, number>> = {};
  const neg: Partial<Record<StatKey, number>> = {};
  for (const k of Object.keys(overclaim) as StatKey[]) {
    const want = overclaim[k] ?? 0;
    if (want <= 0) continue;
    const cur = prev?.[k] ?? 0;
    const cut = Math.min(want, cur); // 0 下限钳制
    if (cut > 0) {
      rolledBack[k] = cut;
      neg[k] = -cut;
    }
  }
  return { stats: accrueStats(prev, neg), rolledBack };
}
