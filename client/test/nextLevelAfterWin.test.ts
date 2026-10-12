import { describe, it, expect } from 'vitest';
import { CAMPAIGN_LEVEL_ORDER } from '@nw/engine/campaign/levels';
import { nextLevelAfterWin } from '../src/app/nav/game/nextLevel';

// ONBOARDING_DESIGN §13: what a won campaign level's result screen offers as its primary button.
describe('nextLevelAfterWin', () => {
  const [first, second] = CAMPAIGN_LEVEL_ORDER;
  const last = CAMPAIGN_LEVEL_ORDER[CAMPAIGN_LEVEL_ORDER.length - 1]!;

  it('leads to the next level in campaign order after a clear', () => {
    expect(nextLevelAfterWin(first!, true, false)).toBe(second);
  });

  it('falls back to the map when the win did not clear the level', () => {
    expect(nextLevelAfterWin(first!, false, false)).toBeNull();
  });

  it('falls back to the map when a chapter-end interlude has to play first', () => {
    expect(nextLevelAfterWin(first!, true, true)).toBeNull();
  });

  it('falls back to the map after the last level and for an unknown id', () => {
    expect(nextLevelAfterWin(last, true, false)).toBeNull();
    expect(nextLevelAfterWin('no_such_level', true, false)).toBeNull();
  });
});
