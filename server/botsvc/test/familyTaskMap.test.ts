import { describe, it, expect } from 'vitest';
import { actionForFamilyTask } from '../src/familyTaskMap';

describe('actionForFamilyTask', () => {
  it('maps known task types to their fixed action', () => {
    expect(actionForFamilyTask('donate_resource_x')).toBe('donate_resource');
    expect(actionForFamilyTask('kill_monster_x')).toBe('start_battle');
    expect(actionForFamilyTask('upgrade_building_x')).toBe('upgrade_building');
  });

  it('falls back to skip for unrecognized task types instead of guessing', () => {
    expect(actionForFamilyTask('some_future_task_nobody_mapped_yet')).toBe('skip');
  });
});
