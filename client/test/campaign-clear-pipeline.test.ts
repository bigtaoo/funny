// End-to-end regression for the composite star scoring pipeline (STAR_SCORING.md): drives the
// REAL production navigation (createAppCore -> lobby -> campaign map -> level prep -> goCampaign)
// through an actual campaign match, not just the unit-level computeStars()/buildStarContext() calls
// (client/test/campaign-rewards.test.ts) or the judge's parallel recompute path
// (client/test/pve-judge.test.ts). This is the one hop those don't cover: game.ts's own
// onGameEnd -> buildStarContext -> computeStars -> saveManager.recordClear glue.
import { describe, it, expect } from 'vitest';
import { createAppCore } from '../src/app/createAppCore';
import { HeadlessPlatform } from './harness/HeadlessPlatform';
import { HeadlessAppViews } from './harness/HeadlessAppViews';
import { BaselinePlayer, DEFAULT_AI } from './difficultySim';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const SAVE_KEY = 'nw_save_v1';

/** Drive lobby -> campaign map -> level prep -> onStart for `levelId`; leaves the match ready to drive. */
async function enterLevel(levelId: string): Promise<{ platform: HeadlessPlatform; views: HeadlessAppViews }> {
  const platform = new HeadlessPlatform(); // offline single-player — no server, local-first save only
  const views = new HeadlessAppViews();
  createAppCore(platform, views).start();

  views.intro!.onFinish();
  views.consent!.onAccept();
  await settle();

  views.lobby!.onOpenCampaign();
  views.campaignMap!.onSelectLevel(levelId);
  views.levelPrep!.onStart();
  expect(views.screen).toBe('game');
  return { platform, views };
}

function readStars(platform: HeadlessPlatform, levelId: string): number | undefined {
  const saved = JSON.parse(platform.storage.getItem(SAVE_KEY) ?? '{}');
  return saved?.progress?.stars?.[levelId];
}

describe('campaign clear pipeline — production onGameEnd -> stars', () => {
  it('a real win (baseline AI defense) records 1..3 stars via recordClear', async () => {
    const { platform, views } = await enterLevel('ch1_lv1');

    // Same baseline AI the difficulty simulator uses (client/test/difficultySim.ts), which clears
    // ch1_lv1 fresh reliably (~80% of seeds in the difficulty report) — deterministic here since the
    // level's own fixed seed (not an EVAL_SEEDS override) drives this match.
    const ai = new BaselinePlayer(DEFAULT_AI);
    const result = await views.driveToEnd({
      maxSeconds: 30,
      ticksPerStep: 200, // offline single-process match — no WS traffic to yield for each tick
      onBeforeTick: (engine, tick) => ai.act(engine, tick),
    });

    expect(result.winner).toBe(0);
    const stars = readStars(platform, 'ch1_lv1');
    expect(stars).toBeGreaterThanOrEqual(1);
    expect(stars).toBeLessThanOrEqual(3);
  }, 30_000);

  it('a real loss (no defense played) records no stars for the level', async () => {
    const { platform, views } = await enterLevel('ch1_lv1');

    // No onBeforeTick — zero cards played all match; ch1_lv1's waves reach the undefended base fast.
    const result = await views.driveToEnd({ maxSeconds: 30, ticksPerStep: 200 });

    expect(result.winner).toBe(1);
    expect(readStars(platform, 'ch1_lv1')).toBeUndefined();
  }, 30_000);
});
