import { describe, expect, it } from 'vitest';
import { levelStaminaCost, DEFAULT_LEVEL_STAMINA_COST } from '../src/app/nav/game/staminaCost';

describe('levelStaminaCost (ONBOARDING_DESIGN §17.5)', () => {
  it('uses the level cost, defaulting to 10', () => {
    expect(levelStaminaCost({}, { staminaCost: 3 })).toBe(3);
    expect(levelStaminaCost({}, {})).toBe(DEFAULT_LEVEL_STAMINA_COST);
  });
  it('is 0 on a free-entry platform (CrazyGames)', () => {
    expect(levelStaminaCost({ freePveStamina: true }, { staminaCost: 5 })).toBe(0);
  });
});
