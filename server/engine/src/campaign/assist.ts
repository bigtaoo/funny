// "Easier retry" transform (ONBOARDING_DESIGN §17.2). A level that opts in with `assistOnLoss` can be
// replayed through `applyAssist` after a loss. The transform is a pure function of the level, so the client,
// the server-side bookkeeping and the peer judge all derive the identical assisted level from the same JSON —
// replay verification still holds.
import type { LevelDefinition } from './LevelDefinition';

/** Enemy hp / damage multiplier on top of the level's own `enemyScale`. */
export const ASSIST_ENEMY_SCALE = 0.7;
/** Extra starting ink (`startInk` is added on top of the player's base ink). */
export const ASSIST_BONUS_INK = 20;

/** Max stars an assisted clear can settle for (metaserver caps the claim). */
export const ASSIST_MAX_STARS = 1;

/**
 * Levels carrying `assistOnLoss: true` in their JSON. The level JSON ships only with the client, so the
 * server side (which validates an `assist` claim) reads this list; a client test keeps the two in sync.
 */
export const ASSIST_LEVEL_IDS: readonly string[] = ['ch1_lv1', 'ch1_lv2', 'ch1_lv3'];

/** The assisted variant of `level`. Throws if the level did not opt in. */
export function applyAssist(level: LevelDefinition): LevelDefinition {
  if (!level.assistOnLoss) throw new Error(`applyAssist: level '${level.id}' has no assistOnLoss`);
  const scale = level.enemyScale ?? { hp: 1, damage: 1 };
  return {
    ...level,
    enemyScale: { hp: (scale.hp ?? 1) * ASSIST_ENEMY_SCALE, damage: (scale.damage ?? 1) * ASSIST_ENEMY_SCALE },
    startInk: (level.startInk ?? 0) + ASSIST_BONUS_INK,
  };
}
