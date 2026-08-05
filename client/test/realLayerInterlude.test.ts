// Unit coverage for resolveRealLayerInterlude — the pure decision extracted from
// nav/game.ts's onGameEnd (see realLayerInterludeArt.ts) that decides whether a just-finished
// campaign match should chain into the chapter-end illustrated interlude (world.md「章末真实
//层：陶与 Anna」) before returning to the map. Kept separate from
// campaign-clear-pipeline.test.ts's full match-simulation coverage: chapter finale levels
// (chN_lv10) are tuned hard enough that a baseline-AI "fresh" win isn't reliably reproducible
// (see test/difficulty/ch1.test.ts's ch1_lv10 fresh row), so this exercises the branching
// directly against fabricated LevelDefinition objects instead of driving a real match.
import { describe, it, expect } from 'vitest';
import { resolveRealLayerInterlude, REAL_LAYER_INTERLUDE_ART } from '../src/scenes/realLayerInterludeArt';
import type { LevelDefinition } from '../src/game';

function level(overrides: Partial<LevelDefinition> = {}): LevelDefinition {
  return {
    id: 'test',
    chapter: 1,
    seed: 1,
    objective: { kind: 'survive' },
    waves: { entries: [] },
    ...overrides,
  } as LevelDefinition;
}

describe('resolveRealLayerInterlude', () => {
  it('returns undefined on a loss, even if the level has a realLayerKey', () => {
    const lv = level({ chapter: 1, story: { realLayerKey: 'campaign.realLayer.ch1' } });
    expect(resolveRealLayerInterlude(lv, 1)).toBeUndefined();
  });

  it('returns undefined on a draw (winner === null)', () => {
    const lv = level({ chapter: 1, story: { realLayerKey: 'campaign.realLayer.ch1' } });
    expect(resolveRealLayerInterlude(lv, null)).toBeUndefined();
  });

  it('returns undefined on a win when the level has no realLayerKey (every non-chN_lv10 level)', () => {
    const lv = level({ chapter: 1, story: { outroKey: 'campaign.ch1.outro' } });
    expect(resolveRealLayerInterlude(lv, 0)).toBeUndefined();
  });

  it('returns undefined on a win when the level has no story block at all', () => {
    const lv = level({ chapter: 1 });
    expect(resolveRealLayerInterlude(lv, 0)).toBeUndefined();
  });

  it('returns the matching art + key on a win for a level with a realLayerKey', () => {
    const lv = level({ chapter: 3, story: { outroKey: 'campaign.ch3.outro', realLayerKey: 'campaign.realLayer.ch3' } });
    const result = resolveRealLayerInterlude(lv, 0);
    expect(result).toEqual({
      illustrationUrl: REAL_LAYER_INTERLUDE_ART[3],
      textKey: 'campaign.realLayer.ch3',
    });
  });

  it('resolves ch6\'s epilogue the same way as any other chapter (reuses campaign.epilogue as the key)', () => {
    const lv = level({ chapter: 6, story: { outroKey: 'campaign.ch6.outro', realLayerKey: 'campaign.epilogue' } });
    const result = resolveRealLayerInterlude(lv, 0);
    expect(result).toEqual({
      illustrationUrl: REAL_LAYER_INTERLUDE_ART[6],
      textKey: 'campaign.epilogue',
    });
  });

  it('every chapter 1-6 has art mapped (defensive fallback in resolveRealLayerInterlude never triggers for real levels)', () => {
    for (let chapter = 1; chapter <= 6; chapter++) {
      expect(REAL_LAYER_INTERLUDE_ART[chapter]).toBeTruthy();
    }
  });
});
