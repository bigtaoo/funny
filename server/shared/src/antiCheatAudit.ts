// Pure-logic implementation of PvP stat anti-cheat L2/L3 (authoritative design in ACHIEVEMENT_DESIGN.md §4.4).
// Pure data + pure functions (randomness/clock injected externally), no DB; called by the meta offline audit batch (anticheatAudit.ts).
//
// L2 random sampling: samples archived ranked games at base probability p0, re-runs them headlessly via an online peer judge
// to obtain authoritative kill/cast counts, then compares against reported values.
// L3 suspect escalation: accounts previously confirmed as cheaters (statSuspicion>0) have their sample probability raised to p_flagged.
import type { StatKey } from './achievements';
import { PVP_REPORTED_STAT_KEYS, accrueStats } from './achievements';
import type { SaveData } from './types';

/** L2 base sampling probability (clean accounts, §4.4). Lightweight low-cost backstop — not worth expensive re-computation for a small coin pool. */
export const AUDIT_SAMPLE_P0 = 0.02;
/** L3 escalated sampling probability (accounts with statSuspicion>0, §4.4). Previously confirmed cheaters → long-term elevated sampling tier. */
export const AUDIT_SAMPLE_P_FLAGGED = 0.35;

export interface AuditSampleOpts {
  p0?: number;
  pFlagged?: number;
}

/**
 * Returns the current sampling probability for this account (§4.4 L3 escalation):
 * previously confirmed cheater (statSuspicion>0) → p_flagged, otherwise p0.
 * Per game, feed the larger statSuspicion of both participants (either side being flagged raises the whole game's sample probability).
 */
export function auditSampleProbability(statSuspicion: number, opts?: AuditSampleOpts): number {
  const p0 = opts?.p0 ?? AUDIT_SAMPLE_P0;
  const pFlagged = opts?.pFlagged ?? AUDIT_SAMPLE_P_FLAGGED;
  return statSuspicion > 0 ? pFlagged : p0;
}

/** Whether to audit this game (random number injected externally for deterministic testing). rand < probability → selected. */
export function shouldAuditSample(
  statSuspicion: number,
  rand: number,
  opts?: AuditSampleOpts,
): boolean {
  return rand < auditSampleProbability(statSuspicion, opts);
}

export interface AuditComparison {
  /** Overclaim amount (`max(0, reported-authoritative)` per statKey, omitting zeros; under-reporting/equal is not counted). */
  overclaim: Partial<Record<StatKey, number>>;
  /** Whether any overclaim exists (→ confirmed cheating, triggers rollback + escalation). */
  suspicious: boolean;
}

/**
 * Compares one side's reported values against the judge-recomputed authoritative values (§4.4 L2).
 * **Only overclaims are flagged**: reported > authoritative counts (under-reporting hurts only the player and is not retroactively corrected;
 * coins already issued are not clawed back, so under-claim/equal = clean). Only iterates {@link PVP_REPORTED_STAT_KEYS}
 * (pvp.wins is computed server-side; campaign.* is PvE — neither is audited).
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
 * Rolls back the overclaim amount from the player's lifetime stats (§4.4 rollback): deducts each statKey,
 * clamped at zero (deduction = `min(overclaim[k], current value)`). Returns the new stats + the actual amount
 * deducted (the theoretical overclaim may exceed the actual deduction; the audit record distinguishes them).
 * Pure function: if there is nothing to deduct, returns prev as-is without instantiating a new object (lazy creation).
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
    const cut = Math.min(want, cur); // clamp at zero
    if (cut > 0) {
      rolledBack[k] = cut;
      neg[k] = -cut;
    }
  }
  return { stats: accrueStats(prev, neg), rolledBack };
}
