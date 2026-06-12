import type { LevelDefinition } from './LevelDefinition';
import { parseLevelDefinition } from './levelSchema';

import ch1Lv1 from './levels/ch1_lv1.json';
import ch1Lv2 from './levels/ch1_lv2.json';
import ch1Lv3 from './levels/ch1_lv3.json';
import chStress from './levels/ch_stress.json';

/**
 * Campaign level registry.
 *
 * Levels are authored as JSON (single source of truth — see
 * `tools/level-editor/DESIGN.md`) and bundled at build time. Each is run through
 * {@link parseLevelDefinition}, which validates the raw JSON and narrows it to a
 * {@link LevelDefinition}; a malformed level fails fast at module load with a
 * field-path error rather than corrupting a match.
 *
 * To add a level: drop its `.json` under `levels/`, import it here, and add it to
 * {@link CAMPAIGN_LEVEL_ORDER}.
 */

const CH1_LV1 = parseLevelDefinition(ch1Lv1, 'ch1_lv1.json');
const CH1_LV2 = parseLevelDefinition(ch1Lv2, 'ch1_lv2.json');
const CH1_LV3 = parseLevelDefinition(ch1Lv3, 'ch1_lv3.json');
const CH_STRESS = parseLevelDefinition(chStress, 'ch_stress.json');

/** Registry of all campaign levels, keyed by id. */
export const CAMPAIGN_LEVELS: Record<string, LevelDefinition> = {
  [CH1_LV1.id]: CH1_LV1,
  [CH1_LV2.id]: CH1_LV2,
  [CH1_LV3.id]: CH1_LV3,
  [CH_STRESS.id]: CH_STRESS,
};

/** Ordered level ids — drives the level-select buttons (4th = swarm stress test). */
export const CAMPAIGN_LEVEL_ORDER: string[] = [CH1_LV1.id, CH1_LV2.id, CH1_LV3.id, CH_STRESS.id];

/** Look up a level by id, or null if unknown. */
export function getLevel(id: string): LevelDefinition | null {
  return CAMPAIGN_LEVELS[id] ?? null;
}
