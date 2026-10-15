// Tutorial resume (ONBOARDING_DESIGN §17.7): a player who finished the guided beats and left during the
// free fight has learned the controls, so the next launch goes straight on to ch1_lv1 instead of
// replaying the tutorial from its first beat. One who left before the beats were done replays it.
import { describe, it, expect, afterEach, vi } from 'vitest';

const tracked = vi.hoisted(() => [] as Array<{ event: string; props: Record<string, unknown> }>);
vi.mock('../src/analytics', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/analytics')>();
  return {
    ...real,
    track: (event: string, props: Record<string, unknown> = {}) => { tracked.push({ event, props }); real.track(event, props); },
  };
});

import { createAppCore } from '../src/app/createAppCore';
import { TUTORIAL_BEATS_DONE_FLAG, TUTORIAL_DONE_FLAG } from '../src/app/appConstants';
import { HeadlessPlatform } from './harness/HeadlessPlatform';
import { HeadlessAppViews } from './harness/HeadlessAppViews';

/** A brand-new CrazyGames-style player (no entry screen) with the given flags. */
async function launch(flags: Record<string, boolean>) {
  const platform = new HeadlessPlatform({ storage: { nw_save_v1: JSON.stringify({ flags }) } });
  Object.defineProperty(platform, 'entryNoticeOnly', { value: true });
  Object.defineProperty(platform, 'silentAccountOnly', { value: true });
  const views = new HeadlessAppViews();
  let tutorialShown = false;
  views.onTutorial = () => { tutorialShown = true; };
  createAppCore(platform, views).start();
  const deadline = Date.now() + 3000;
  while (views.screen !== 'game' && !tutorialShown && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  const stored = (JSON.parse(platform.storage.getItem('nw_save_v1') ?? '{}') as { flags?: Record<string, boolean> }).flags ?? {};
  return { views, tutorialShown, stored };
}

describe('tutorial resume', () => {
  afterEach(() => { vi.restoreAllMocks(); tracked.length = 0; });

  it('beats done last time → straight into ch1_lv1, tutorial marked done', async () => {
    const { views, tutorialShown, stored } = await launch({ [TUTORIAL_BEATS_DONE_FLAG]: true });
    expect(tutorialShown).toBe(false);
    expect(views.screen).toBe('game');
    expect(stored[TUTORIAL_DONE_FLAG]).toBe(true);
    expect(tracked).toContainEqual({ event: 'tutorial_skip', props: { step: 'resume' } });
    expect(tracked.find((e) => e.event === 'level_attempt')?.props).toMatchObject({ level_id: 'ch1_lv1' });
    expect(tracked.some((e) => e.event === 'tutorial_start')).toBe(false);
  });

  it('left before the beats were done → the tutorial runs again', async () => {
    const { tutorialShown } = await launch({});
    expect(tutorialShown).toBe(true);
    expect(tracked.some((e) => e.event === 'tutorial_start')).toBe(true);
  });
});
