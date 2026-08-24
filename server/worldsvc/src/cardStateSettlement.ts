// Post-battle card-army state (CC-3, CHARACTER_CARDS_DESIGN §7.1/§7.2), split out of siegeEngine.ts on
// 2026-08-24 when adding the delta-write builder pushed that file past the 500-line convention
// (claudedocs/server.md "单文件 500 行收敛"). Per the split-priority order these three symbols are the
// "independent function module" case: one cohesive unit — what a battle does to the cards that fought it,
// and how that is persisted — with no dependency on the rest of the engine.
//
// Re-exported from siegeEngine.ts, so every existing `from '../../siegeEngine'` import keeps working.
import { CARD_BASE_SURVIVAL, CARD_INJURY_DURATION_MS } from '@nw/shared';
import type { ArmyEntry, CardSLGState } from './db';

/** Post-battle card state updates for attacker cards (CC-3, CHARACTER_CARDS_DESIGN §7.1/§7.2). */
export interface CardStateUpdate {
  currentTroops: number;
  /**
   * How many troops this card LOST in the battle (`deployed - currentTroops`, never negative).
   *
   * 2026-08-24 (user decision): topping a card up mid-march stays allowed, so the settlement must not
   * publish `currentTroops` as an absolute — a `distributeTroops` `$inc` landing between the read and the
   * write would be erased and the player would lose troops they had already paid for out of the pool.
   * Persisting the loss as a delta instead commutes with that top-up. With no concurrent write the two are
   * identical (`deployed - losses === currentTroops`), so battle numbers are unchanged; a top-up that does
   * land simply survives at full strength rather than being retroactively subjected to the survival rate.
   */
  losses: number;
  injuredUntil?: number;
}

/**
 * The single place that turns {@link computeCardStateUpdates} output into a write. Returns an
 * aggregation-pipeline stage list, so the loss is applied to the LIVE `currentTroops` and clamped at zero
 * (a card cannot go negative even if something else drained it first). `injuredUntil` stays an absolute —
 * it is a battle verdict, not a running total.
 *
 * Empty updates → empty pipeline; callers skip the write, same as they did with the old `$set` map.
 */
export function cardStateDeltaPipeline(updates: Record<string, CardStateUpdate>): Record<string, unknown>[] {
  const set: Record<string, unknown> = {};
  for (const [id, u] of Object.entries(updates)) {
    set[`cardState.${id}.currentTroops`] = {
      $max: [0, { $subtract: [{ $ifNull: [`$cardState.${id}.currentTroops`, 0] }, u.losses] }],
    };
    set[`cardState.${id}.injuredUntil`] = u.injuredUntil != null ? u.injuredUntil : null;
  }
  if (Object.keys(set).length === 0) return [];
  return [{ $set: { ...set, rev: { $add: ['$rev', 1] } } }];
}

/**
 * Computes per-card state updates after a siege battle (CC-3).
 * Uses a uniform attacker survival rate (total surviving HP / total deployed HP) applied proportionally
 * to each card's currentTroops. Cards whose HP reaches zero (total survivors == 0) are marked injured.
 * baseSurvival guarantees a minimum troop fraction even on full defeat (CHARACTER_CARDS_DESIGN §7.1).
 *
 * @param army            Attacker army entries with cardInstanceId
 * @param cardState       Current card state (for deployedTroops lookup)
 * @param attackerSurvivors Total attacker surviving HP from the engine
 * @param nowMs           Current time in ms (for injuredUntil calculation)
 */
/**
 * Concurrency: the four callers that persist this (arrival/baseSiege, arrival/landSiege, encounter,
 * occupationBattle) all `$set` dotted `cardState.<id>.*` paths on `_id` alone. The 2026-08-24
 * unguarded-write sweep left them that way on purpose — per-card paths plus the TEAM_BUSY gate mean two
 * settlements can never target one card, and nothing here replaces `cardState` wholesale. The one open
 * interaction (a `distributeTroops` top-up landing inside a settlement) and why closing it is a gameplay
 * decision rather than a concurrency fix are written up in claudedocs/server.md.
 */
export function computeCardStateUpdates(
  army: ArmyEntry[],
  cardState: Record<string, CardSLGState>,
  attackerSurvivors: number,
  nowMs: number,
  attackerDeployed?: number,
): Record<string, CardStateUpdate> {
  const updates: Record<string, CardStateUpdate> = {};
  const cardIds = army.map((e) => e.cardInstanceId).filter((id): id is string => !!id);
  if (cardIds.length === 0) return updates;

  const nominalTroops = cardIds.reduce((s, id) => s + (cardState[id]?.currentTroops ?? 0), 0);
  // If no troops deployed, no state change needed.
  if (nominalTroops === 0) return updates;

  // ADR-069: the survival ratio must compare like with like. `attackerSurvivors` comes out of the
  // engine as a sum of per-unit HP, each one clamped to that unit's blueprint capacity, so on the
  // engine path it can never reach the team's NOMINAL troop total — dividing by the nominal total
  // (the pre-ADR-069 behavior) capped survival at the clamp ratio (~40-60% for a real card team)
  // and shredded the team's troops on every battle, won or lost, which is how a player who kept
  // attacking watched a full team decay to nothing in a handful of fights. Callers that ran the
  // engine pass `SiegeResolution.attackerDeployed` (the clamped deployed sum); the cheap linear
  // path's survivors are already in raw-troop units, so its `attackerDeployed` equals the nominal
  // troops and the ratio is unchanged. Omitted / non-positive → fall back to the nominal total.
  const denominator = attackerDeployed && attackerDeployed > 0 ? attackerDeployed : nominalTroops;

  // Apply baseSurvival floor: even at 0 survivors, each card keeps baseSurvival fraction of its troops.
  const survivalRate = Math.max(
    CARD_BASE_SURVIVAL,
    Math.min(1, attackerSurvivors / denominator),
  );
  const totalZero = attackerSurvivors === 0;

  for (const id of cardIds) {
    const deployed = cardState[id]?.currentTroops ?? 0;
    const newTroops = Math.round(deployed * survivalRate);
    // survivalRate is clamped to <= 1 above, so newTroops <= deployed and the loss is never negative.
    const update: CardStateUpdate = { currentTroops: newTroops, losses: Math.max(0, deployed - newTroops) };
    if (totalZero) update.injuredUntil = nowMs + CARD_INJURY_DURATION_MS;
    updates[id] = update;
  }
  return updates;
}
