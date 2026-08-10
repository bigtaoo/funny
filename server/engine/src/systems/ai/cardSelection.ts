// Split from AISystem.ts (2026-08-10, independent function module range 6, part 3/5).
// Hand-card lookup + the counter-picking matchup score, unchanged behaviour — just
// pulled out of the class body since none of this touches AiCtx state directly
// (pickUnitCard takes `useCounterPicking` explicitly instead of reading `this.params`).
import { GameState } from '../../GameState';
import { CardDefinition, CardType, UnitBlueprint, Side } from '../../types';
import { LEGACY_DEFENSE_PREFERENCE, LEGACY_OFFENSE_PREFERENCE } from './types';

/** First affordable hand slot matching `pred`, or null. */
export function findCardIndex(
  cards: (CardDefinition | null)[],
  ink: number,
  pred: (c: CardDefinition) => boolean,
): number | null {
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (!card || ink < card.cost) continue;
    if (pred(card)) return i;
  }
  return null;
}

/**
 * Choose an affordable unit card for `lane`. Below {@link DifficultyParams.useCounterPicking}
 * this keeps the original fixed species-preference order (deliberately unsophisticated,
 * mirrors a beginner always reaching for the same card). At/above the threshold it scores
 * every affordable unit card generically from public {@link UnitBlueprint} stats against
 * whatever enemy units are actually sitting in that lane — no hardcoded per-unit-id table,
 * so it scales to the whole card pool (including units the legacy preference list never
 * touched: Max/Lena/Mara/Runner/Ironclad/Berserker/Splitter/Harpy/Medic).
 */
export function pickUnitCard(
  state: GameState,
  cards: (CardDefinition | null)[],
  ink: number,
  lane: number,
  forDefense: boolean,
  useCounterPicking: boolean,
): number | null {
  if (!useCounterPicking) {
    const preference = forDefense ? LEGACY_DEFENSE_PREFERENCE : LEGACY_OFFENSE_PREFERENCE;
    for (const want of preference) {
      const idx = findCardIndex(cards, ink, (c) =>
        c.cardType === CardType.Unit && c.unitType === want);
      if (idx !== null) return idx;
    }
    return null;
  }

  const enemyBps = enemyBlueprintsInLane(state, lane);
  let bestIdx: number | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (!card || card.cardType !== CardType.Unit || !card.unitType) continue;
    if (ink < card.cost) continue;
    const bp = state.unitBlueprints[card.unitType];
    const score = counterScore(bp, enemyBps) / card.cost;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
}

/** Public {@link UnitBlueprint}s for enemy (Bottom) units currently standing in `lane`. */
export function enemyBlueprintsInLane(state: GameState, lane: number): UnitBlueprint[] {
  const out: UnitBlueprint[] = [];
  for (const unit of state.board.units.values()) {
    if (unit.side !== Side.Bottom || unit.isDead || unit.col !== lane) continue;
    out.push(state.unitBlueprints[unit.unitType]);
  }
  return out;
}

/**
 * Generic matchup score for `candidate` against a set of enemy blueprints,
 * derived only from stats every player can see on both units (HP / attack /
 * attack interval / range / armor / flying). Higher = candidate trades better.
 * With no enemies present this returns 0 (any unit is fine to send).
 */
export function counterScore(candidate: UnitBlueprint, enemies: UnitBlueprint[]): number {
  if (enemies.length === 0) return 0;
  let score = 0;
  for (const enemy of enemies) {
    const dmgToEnemy = Math.max(1, candidate.attack - (enemy.armor ?? 0));
    const dmgFromEnemy = Math.max(1, enemy.attack - (candidate.armor ?? 0));
    const candidateDps = dmgToEnemy / candidate.attackInterval;
    const enemyDps = dmgFromEnemy / enemy.attackInterval;
    const timeToKill = enemy.hp / Math.max(0.01, candidateDps);
    const timeToDie = candidate.hp / Math.max(0.01, enemyDps);
    score += timeToDie - timeToKill;
    // Range advantage: hits before the enemy can reply.
    score += (candidate.range - enemy.range) * 2;
    // Can't touch a flyer without canTargetFlying — a hard counter, not a soft one.
    if (enemy.flying && !candidate.canTargetFlying) score -= 50;
  }
  return score / enemies.length;
}
