// Shared level fixture for the input / drag-preview UI tests. Their hand-slot constants depend on the
// exact opening hand, so the fixture pins ch1_lv1's pre-redesign 12-card loadout instead of following
// campaign content edits (ONBOARDING_DESIGN §17 trimmed the real ch1_lv1 loadout to five cards).
import { getLevel } from '../../src/game';

const INPUT_TEST_LOADOUT = [
  'infantry_1', 'infantry_2', 'shieldbearer_1', 'shieldbearer_2', 'archer_1', 'archer_2',
  'barracks_1', 'barracks_2', 'tower_1', 'tower_2', 'haste_1', 'meteor_1',
];

export function inputTestLevel() {
  return { ...getLevel('ch1_lv1')!, loadout: INPUT_TEST_LOADOUT, cardUnlocks: undefined };
}
