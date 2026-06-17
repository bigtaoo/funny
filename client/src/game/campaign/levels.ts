import type { LevelDefinition } from './LevelDefinition';
import { parseLevelDefinition } from './levelSchema';

import ch1Lv1  from './levels/ch1_lv1.json';
import ch1Lv2  from './levels/ch1_lv2.json';
import ch1Lv3  from './levels/ch1_lv3.json';
import ch1Lv4  from './levels/ch1_lv4.json';
import ch1Lv5  from './levels/ch1_lv5.json';
import ch1Lv6  from './levels/ch1_lv6.json';
import ch1Lv7  from './levels/ch1_lv7.json';
import ch1Lv8  from './levels/ch1_lv8.json';
import ch1Lv9  from './levels/ch1_lv9.json';
import ch1Lv10 from './levels/ch1_lv10.json';
import ch2Lv1  from './levels/ch2_lv1.json';
import ch2Lv2  from './levels/ch2_lv2.json';
import ch2Lv3  from './levels/ch2_lv3.json';
import ch2Lv4  from './levels/ch2_lv4.json';
import ch2Lv5  from './levels/ch2_lv5.json';
import ch2Lv6  from './levels/ch2_lv6.json';
import ch2Lv7  from './levels/ch2_lv7.json';
import ch2Lv8  from './levels/ch2_lv8.json';
import ch2Lv9  from './levels/ch2_lv9.json';
import ch2Lv10 from './levels/ch2_lv10.json';
import ch3Lv1  from './levels/ch3_lv1.json';
import ch3Lv2  from './levels/ch3_lv2.json';
import ch3Lv3  from './levels/ch3_lv3.json';
import ch3Lv4  from './levels/ch3_lv4.json';
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

const CH1_LV1  = parseLevelDefinition(ch1Lv1,  'ch1_lv1.json');
const CH1_LV2  = parseLevelDefinition(ch1Lv2,  'ch1_lv2.json');
const CH1_LV3  = parseLevelDefinition(ch1Lv3,  'ch1_lv3.json');
const CH1_LV4  = parseLevelDefinition(ch1Lv4,  'ch1_lv4.json');
const CH1_LV5  = parseLevelDefinition(ch1Lv5,  'ch1_lv5.json');
const CH1_LV6  = parseLevelDefinition(ch1Lv6,  'ch1_lv6.json');
const CH1_LV7  = parseLevelDefinition(ch1Lv7,  'ch1_lv7.json');
const CH1_LV8  = parseLevelDefinition(ch1Lv8,  'ch1_lv8.json');
const CH1_LV9  = parseLevelDefinition(ch1Lv9,  'ch1_lv9.json');
const CH1_LV10 = parseLevelDefinition(ch1Lv10, 'ch1_lv10.json');
const CH2_LV1  = parseLevelDefinition(ch2Lv1,  'ch2_lv1.json');
const CH2_LV2  = parseLevelDefinition(ch2Lv2,  'ch2_lv2.json');
const CH2_LV3  = parseLevelDefinition(ch2Lv3,  'ch2_lv3.json');
const CH2_LV4  = parseLevelDefinition(ch2Lv4,  'ch2_lv4.json');
const CH2_LV5  = parseLevelDefinition(ch2Lv5,  'ch2_lv5.json');
const CH2_LV6  = parseLevelDefinition(ch2Lv6,  'ch2_lv6.json');
const CH2_LV7  = parseLevelDefinition(ch2Lv7,  'ch2_lv7.json');
const CH2_LV8  = parseLevelDefinition(ch2Lv8,  'ch2_lv8.json');
const CH2_LV9  = parseLevelDefinition(ch2Lv9,  'ch2_lv9.json');
const CH2_LV10 = parseLevelDefinition(ch2Lv10, 'ch2_lv10.json');
const CH3_LV1  = parseLevelDefinition(ch3Lv1,  'ch3_lv1.json');
const CH3_LV2  = parseLevelDefinition(ch3Lv2,  'ch3_lv2.json');
const CH3_LV3  = parseLevelDefinition(ch3Lv3,  'ch3_lv3.json');
const CH3_LV4  = parseLevelDefinition(ch3Lv4,  'ch3_lv4.json');
const CH_STRESS = parseLevelDefinition(chStress, 'ch_stress.json');

/** Registry of all campaign levels, keyed by id. */
export const CAMPAIGN_LEVELS: Record<string, LevelDefinition> = {
  [CH1_LV1.id]:  CH1_LV1,
  [CH1_LV2.id]:  CH1_LV2,
  [CH1_LV3.id]:  CH1_LV3,
  [CH1_LV4.id]:  CH1_LV4,
  [CH1_LV5.id]:  CH1_LV5,
  [CH1_LV6.id]:  CH1_LV6,
  [CH1_LV7.id]:  CH1_LV7,
  [CH1_LV8.id]:  CH1_LV8,
  [CH1_LV9.id]:  CH1_LV9,
  [CH1_LV10.id]: CH1_LV10,
  [CH2_LV1.id]:  CH2_LV1,
  [CH2_LV2.id]:  CH2_LV2,
  [CH2_LV3.id]:  CH2_LV3,
  [CH2_LV4.id]:  CH2_LV4,
  [CH2_LV5.id]:  CH2_LV5,
  [CH2_LV6.id]:  CH2_LV6,
  [CH2_LV7.id]:  CH2_LV7,
  [CH2_LV8.id]:  CH2_LV8,
  [CH2_LV9.id]:  CH2_LV9,
  [CH2_LV10.id]: CH2_LV10,
  [CH3_LV1.id]:  CH3_LV1,
  [CH3_LV2.id]:  CH3_LV2,
  [CH3_LV3.id]:  CH3_LV3,
  [CH3_LV4.id]:  CH3_LV4,
  [CH_STRESS.id]: CH_STRESS,
};

/** Ordered level ids — drives the level-select / CampaignMapScene. */
export const CAMPAIGN_LEVEL_ORDER: string[] = [
  CH1_LV1.id, CH1_LV2.id, CH1_LV3.id, CH1_LV4.id, CH1_LV5.id,
  CH1_LV6.id, CH1_LV7.id, CH1_LV8.id, CH1_LV9.id, CH1_LV10.id,
  CH2_LV1.id, CH2_LV2.id, CH2_LV3.id, CH2_LV4.id, CH2_LV5.id,
  CH2_LV6.id, CH2_LV7.id, CH2_LV8.id, CH2_LV9.id, CH2_LV10.id,
  CH3_LV1.id, CH3_LV2.id, CH3_LV3.id, CH3_LV4.id,
  CH_STRESS.id,
];

/** Look up a level by id, or null if unknown. */
export function getLevel(id: string): LevelDefinition | null {
  return CAMPAIGN_LEVELS[id] ?? null;
}
