import type { IPlatform } from '../../../platform/IPlatform';

/** Default PvE entry cost when a level sets none (server `DEFAULT_STAMINA_COST`). */
export const DEFAULT_LEVEL_STAMINA_COST = 10;

/**
 * Stamina a campaign entry costs on this platform: 0 where entries are free (CrazyGames,
 * ONBOARDING_DESIGN §17.5), otherwise the level's own cost.
 */
export function levelStaminaCost(platform: Pick<IPlatform, 'freePveStamina'>, level: { staminaCost?: number }): number {
  return platform.freePveStamina ? 0 : level.staminaCost ?? DEFAULT_LEVEL_STAMINA_COST;
}
