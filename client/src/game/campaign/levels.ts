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
import ch3Lv5  from './levels/ch3_lv5.json';
import ch3Lv6  from './levels/ch3_lv6.json';
import ch3Lv7  from './levels/ch3_lv7.json';
import ch3Lv8  from './levels/ch3_lv8.json';
import ch3Lv9  from './levels/ch3_lv9.json';
import ch3Lv10 from './levels/ch3_lv10.json';
import ch4Lv1  from './levels/ch4_lv1.json';
import ch4Lv2  from './levels/ch4_lv2.json';
import ch4Lv3  from './levels/ch4_lv3.json';
import ch4Lv4  from './levels/ch4_lv4.json';
import ch4Lv5  from './levels/ch4_lv5.json';
import ch4Lv6  from './levels/ch4_lv6.json';
import ch4Lv7  from './levels/ch4_lv7.json';
import ch4Lv8  from './levels/ch4_lv8.json';
import ch4Lv9  from './levels/ch4_lv9.json';
import ch4Lv10 from './levels/ch4_lv10.json';
import ch5Lv1  from './levels/ch5_lv1.json';
import ch5Lv2  from './levels/ch5_lv2.json';
import ch5Lv3  from './levels/ch5_lv3.json';
import ch5Lv4  from './levels/ch5_lv4.json';
import ch5Lv5  from './levels/ch5_lv5.json';
import ch5Lv6  from './levels/ch5_lv6.json';
import ch5Lv7  from './levels/ch5_lv7.json';
import ch5Lv8  from './levels/ch5_lv8.json';
import ch5Lv9  from './levels/ch5_lv9.json';
import ch5Lv10 from './levels/ch5_lv10.json';
import ch6Lv1  from './levels/ch6_lv1.json';
import ch6Lv2  from './levels/ch6_lv2.json';
import ch6Lv3  from './levels/ch6_lv3.json';
import ch6Lv4  from './levels/ch6_lv4.json';
import ch6Lv5  from './levels/ch6_lv5.json';
import ch6Lv6  from './levels/ch6_lv6.json';
import ch6Lv7  from './levels/ch6_lv7.json';
import ch6Lv8  from './levels/ch6_lv8.json';
import ch6Lv9  from './levels/ch6_lv9.json';
import ch6Lv10 from './levels/ch6_lv10.json';
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
const CH3_LV5  = parseLevelDefinition(ch3Lv5,  'ch3_lv5.json');
const CH3_LV6  = parseLevelDefinition(ch3Lv6,  'ch3_lv6.json');
const CH3_LV7  = parseLevelDefinition(ch3Lv7,  'ch3_lv7.json');
const CH3_LV8  = parseLevelDefinition(ch3Lv8,  'ch3_lv8.json');
const CH3_LV9  = parseLevelDefinition(ch3Lv9,  'ch3_lv9.json');
const CH3_LV10 = parseLevelDefinition(ch3Lv10, 'ch3_lv10.json');
const CH4_LV1  = parseLevelDefinition(ch4Lv1,  'ch4_lv1.json');
const CH4_LV2  = parseLevelDefinition(ch4Lv2,  'ch4_lv2.json');
const CH4_LV3  = parseLevelDefinition(ch4Lv3,  'ch4_lv3.json');
const CH4_LV4  = parseLevelDefinition(ch4Lv4,  'ch4_lv4.json');
const CH4_LV5  = parseLevelDefinition(ch4Lv5,  'ch4_lv5.json');
const CH4_LV6  = parseLevelDefinition(ch4Lv6,  'ch4_lv6.json');
const CH4_LV7  = parseLevelDefinition(ch4Lv7,  'ch4_lv7.json');
const CH4_LV8  = parseLevelDefinition(ch4Lv8,  'ch4_lv8.json');
const CH4_LV9  = parseLevelDefinition(ch4Lv9,  'ch4_lv9.json');
const CH4_LV10 = parseLevelDefinition(ch4Lv10, 'ch4_lv10.json');
const CH5_LV1  = parseLevelDefinition(ch5Lv1,  'ch5_lv1.json');
const CH5_LV2  = parseLevelDefinition(ch5Lv2,  'ch5_lv2.json');
const CH5_LV3  = parseLevelDefinition(ch5Lv3,  'ch5_lv3.json');
const CH5_LV4  = parseLevelDefinition(ch5Lv4,  'ch5_lv4.json');
const CH5_LV5  = parseLevelDefinition(ch5Lv5,  'ch5_lv5.json');
const CH5_LV6  = parseLevelDefinition(ch5Lv6,  'ch5_lv6.json');
const CH5_LV7  = parseLevelDefinition(ch5Lv7,  'ch5_lv7.json');
const CH5_LV8  = parseLevelDefinition(ch5Lv8,  'ch5_lv8.json');
const CH5_LV9  = parseLevelDefinition(ch5Lv9,  'ch5_lv9.json');
const CH5_LV10 = parseLevelDefinition(ch5Lv10, 'ch5_lv10.json');
const CH6_LV1  = parseLevelDefinition(ch6Lv1,  'ch6_lv1.json');
const CH6_LV2  = parseLevelDefinition(ch6Lv2,  'ch6_lv2.json');
const CH6_LV3  = parseLevelDefinition(ch6Lv3,  'ch6_lv3.json');
const CH6_LV4  = parseLevelDefinition(ch6Lv4,  'ch6_lv4.json');
const CH6_LV5  = parseLevelDefinition(ch6Lv5,  'ch6_lv5.json');
const CH6_LV6  = parseLevelDefinition(ch6Lv6,  'ch6_lv6.json');
const CH6_LV7  = parseLevelDefinition(ch6Lv7,  'ch6_lv7.json');
const CH6_LV8  = parseLevelDefinition(ch6Lv8,  'ch6_lv8.json');
const CH6_LV9  = parseLevelDefinition(ch6Lv9,  'ch6_lv9.json');
const CH6_LV10 = parseLevelDefinition(ch6Lv10, 'ch6_lv10.json');
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
  [CH3_LV5.id]:  CH3_LV5,
  [CH3_LV6.id]:  CH3_LV6,
  [CH3_LV7.id]:  CH3_LV7,
  [CH3_LV8.id]:  CH3_LV8,
  [CH3_LV9.id]:  CH3_LV9,
  [CH3_LV10.id]: CH3_LV10,
  [CH4_LV1.id]:  CH4_LV1,
  [CH4_LV2.id]:  CH4_LV2,
  [CH4_LV3.id]:  CH4_LV3,
  [CH4_LV4.id]:  CH4_LV4,
  [CH4_LV5.id]:  CH4_LV5,
  [CH4_LV6.id]:  CH4_LV6,
  [CH4_LV7.id]:  CH4_LV7,
  [CH4_LV8.id]:  CH4_LV8,
  [CH4_LV9.id]:  CH4_LV9,
  [CH4_LV10.id]: CH4_LV10,
  [CH5_LV1.id]:  CH5_LV1,
  [CH5_LV2.id]:  CH5_LV2,
  [CH5_LV3.id]:  CH5_LV3,
  [CH5_LV4.id]:  CH5_LV4,
  [CH5_LV5.id]:  CH5_LV5,
  [CH5_LV6.id]:  CH5_LV6,
  [CH5_LV7.id]:  CH5_LV7,
  [CH5_LV8.id]:  CH5_LV8,
  [CH5_LV9.id]:  CH5_LV9,
  [CH5_LV10.id]: CH5_LV10,
  [CH6_LV1.id]:  CH6_LV1,
  [CH6_LV2.id]:  CH6_LV2,
  [CH6_LV3.id]:  CH6_LV3,
  [CH6_LV4.id]:  CH6_LV4,
  [CH6_LV5.id]:  CH6_LV5,
  [CH6_LV6.id]:  CH6_LV6,
  [CH6_LV7.id]:  CH6_LV7,
  [CH6_LV8.id]:  CH6_LV8,
  [CH6_LV9.id]:  CH6_LV9,
  [CH6_LV10.id]: CH6_LV10,
  [CH_STRESS.id]: CH_STRESS,
};

/** Ordered level ids — drives the level-select / CampaignMapScene. */
export const CAMPAIGN_LEVEL_ORDER: string[] = [
  CH1_LV1.id, CH1_LV2.id, CH1_LV3.id, CH1_LV4.id, CH1_LV5.id,
  CH1_LV6.id, CH1_LV7.id, CH1_LV8.id, CH1_LV9.id, CH1_LV10.id,
  CH2_LV1.id, CH2_LV2.id, CH2_LV3.id, CH2_LV4.id, CH2_LV5.id,
  CH2_LV6.id, CH2_LV7.id, CH2_LV8.id, CH2_LV9.id, CH2_LV10.id,
  CH3_LV1.id,  CH3_LV2.id,  CH3_LV3.id,  CH3_LV4.id,  CH3_LV5.id,
  CH3_LV6.id,  CH3_LV7.id,  CH3_LV8.id,  CH3_LV9.id,  CH3_LV10.id,
  CH4_LV1.id,  CH4_LV2.id,  CH4_LV3.id,  CH4_LV4.id,  CH4_LV5.id,
  CH4_LV6.id,  CH4_LV7.id,  CH4_LV8.id,  CH4_LV9.id,  CH4_LV10.id,
  CH5_LV1.id,  CH5_LV2.id,  CH5_LV3.id,  CH5_LV4.id,  CH5_LV5.id,
  CH5_LV6.id,  CH5_LV7.id,  CH5_LV8.id,  CH5_LV9.id,  CH5_LV10.id,
  CH6_LV1.id,  CH6_LV2.id,  CH6_LV3.id,  CH6_LV4.id,  CH6_LV5.id,
  CH6_LV6.id,  CH6_LV7.id,  CH6_LV8.id,  CH6_LV9.id,  CH6_LV10.id,
  CH_STRESS.id,
];

/** Look up a level by id, or null if unknown. */
export function getLevel(id: string): LevelDefinition | null {
  return CAMPAIGN_LEVELS[id] ?? null;
}
