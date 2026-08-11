// End-to-end regression for the chapter-end "real layer" interlude wiring (world.md「章末真实
// 层：涛与 Anna」): a REAL win, through the production nav (createAppCore -> lobby -> campaign
// map -> level prep -> goCampaign -> onGameEnd -> ResultScene -> IllustratedInterludeScene ->
// back to the map), not just resolveRealLayerInterlude's unit-level branching
// (realLayerInterlude.test.ts).
//
// chN_lv10 levels (the real levels that carry story.realLayerKey) are tuned hard enough that a
// baseline-AI "fresh" win isn't reliably reproducible (test/difficulty/ch1.test.ts's ch1_lv10
// fresh row is 0%), so this drives the reliable ch1_lv1 win instead and temporarily splices a
// realLayerKey onto its story block — same shape as a real chN_lv10, just on a level that
// actually clears. The splice is undone in `finally` so it can't leak into any other test file
// sharing this module's registry instance.
import { describe, it, expect } from 'vitest';
import { createAppCore } from '../src/app/createAppCore';
import { HeadlessPlatform } from './harness/HeadlessPlatform';
import { HeadlessAppViews } from './harness/HeadlessAppViews';
import { BaselinePlayer, DEFAULT_AI } from './difficultySim';
import { CAMPAIGN_LEVELS } from '../src/game';
import { REAL_LAYER_INTERLUDE_ART } from '../src/scenes/realLayerInterludeArt';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function enterLevel(levelId: string): Promise<HeadlessAppViews> {
  const platform = new HeadlessPlatform();
  const views = new HeadlessAppViews();
  createAppCore(platform, views).start();

  views.intro!.onFinish();
  views.consent!.onAccept();
  await settle();

  views.lobby!.onOpenCampaign();
  views.campaignMap!.onSelectLevel(levelId);
  views.levelPrep!.onStart();
  expect(views.screen).toBe('game');
  return views;
}

describe('campaign real-layer interlude — nav wiring around a real win', () => {
  it('a chapter-finale-shaped win shows the illustrated interlude after the result, then returns to the map', async () => {
    const lv1 = CAMPAIGN_LEVELS['ch1_lv1']!;
    const originalStory = lv1.story;
    lv1.story = { ...originalStory, realLayerKey: 'campaign.realLayer.ch1' };
    try {
      const views = await enterLevel('ch1_lv1');
      const ai = new BaselinePlayer(DEFAULT_AI);
      const result = await views.driveToEnd({
        maxSeconds: 30,
        ticksPerStep: 200,
        onBeforeTick: (engine, tick) => ai.act(engine, tick),
      });
      expect(result.winner).toBe(0);

      // The result panel comes up first — the interlude has not been shown yet.
      expect(views.screen).toBe('result');
      expect(views.realLayerInterlude).toBeUndefined();

      // Tapping the primary CTA (wired to `proceedToMap`, campaign's "back to map" button)
      // chains into the interlude instead of going straight to the map.
      views.result!.cb.onPlayAgain();
      expect(views.screen).toBe('realLayerInterlude');
      expect(views.realLayerInterlude?.textKey).toBe('campaign.realLayer.ch1');
      expect(views.realLayerInterlude?.illustrationUrl).toBe(REAL_LAYER_INTERLUDE_ART[1]);

      // Finishing the interlude (tap-through or skip) is what actually returns to the map.
      expect(views.screen).not.toBe('campaignMap');
      views.realLayerInterlude!.cb.onFinish();
      expect(views.screen).toBe('campaignMap');
    } finally {
      lv1.story = originalStory; // undo the splice regardless of pass/fail
    }
  }, 30_000);

  it('a plain win (no realLayerKey on the level) goes straight from the result to the map', async () => {
    // ch1_lv1 unmodified — no splice this time, proving the interlude path above is opt-in.
    const views = await enterLevel('ch1_lv1');
    const ai = new BaselinePlayer(DEFAULT_AI);
    const result = await views.driveToEnd({
      maxSeconds: 30,
      ticksPerStep: 200,
      onBeforeTick: (engine, tick) => ai.act(engine, tick),
    });
    expect(result.winner).toBe(0);
    expect(views.screen).toBe('result');

    views.result!.cb.onPlayAgain();
    expect(views.screen).toBe('campaignMap');
    expect(views.realLayerInterlude).toBeUndefined();
  }, 30_000);
});
