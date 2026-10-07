// Tutorial navigation: the dedicated tutorial level ch0_tutorial and its graduation hand-off into the
// first campaign level (ONBOARDING_DESIGN §3.6 / §11). Split out of campaignRoster.ts (500-line rule);
// it reaches the campaign entry points through the shared `nav` registry like every other factory.
import * as analytics from '../../../analytics';
import { getLevel, CAMPAIGN_LEVEL_ORDER } from '../../../game';
import { TUTORIAL_LEVEL_ID } from '@nw/engine';
import { WELCOME_MAIL_COINS } from '@nw/shared/onboarding';
import { t } from '../../../i18n';
import type { AppCtx, Nav } from '../../appCtx';
import { TUTORIAL_DONE_FLAG } from '../../appConstants';

type TutorialNav = Pick<Nav, 'goTutorial'>;

export function createTutorialNav(ctx: AppCtx): TutorialNav {
  const { saveManager, platform, state, views, nav } = ctx;

  /**
   * Dedicated tutorial level ch0_tutorial (ONBOARDING_DESIGN §3). Never fails: the director owns the
   * endgame, so winner is always the local player. Does not count toward campaign progress
   * (recordClear is not called).
   *
   * Graduation (§3.6): on a brand-new account the graduation card's button goes straight into the
   * first campaign level — the player has just learned to drag and gets a real, winnable fight while
   * the hand is warm, instead of a lobby whose primary button is ranked PvP. The card also announces
   * the author's welcome-mail coins, which the server pays on the first-ever clear (pve/clear.ts), so
   * the promise is only shown while it is still true. A replay from settings, or an account that has
   * already cleared a level, just returns to the lobby. Skip always returns to the lobby.
   *
   * Every step also ticks the anonymous per-step counter, which is a no-op once analytics consent is
   * granted — it is what still shows where unconsented players stop (ANALYTICS_DESIGN §3.6d).
   */
  function goTutorial(): void {
    const level = getLevel(TUTORIAL_LEVEL_ID);
    if (!level) { nav.goLobby(); return; }  // If the tutorial level is missing, skip silently rather than blocking new players.
    state.inLobby = false;
    platform.onGameplayStart();
    analytics.track('tutorial_start', { level_id: TUTORIAL_LEVEL_ID });
    analytics.countAnonymousTutorialStep('tutorial_start');
    const firstLevelId = CAMPAIGN_LEVEL_ORDER[0];
    const freshAccount = !saveManager.getFlag(TUTORIAL_DONE_FLAG) && saveManager.get().progress.cleared.length === 0;
    const nextLevelId = freshAccount && firstLevelId && getLevel(firstLevelId) ? firstLevelId : null;
    views.showGame({
      onGameEnd(_winner, _stats, _replay) {
        saveManager.setFlag(TUTORIAL_DONE_FLAG, true);
        analytics.track('tutorial_complete', { level_id: TUTORIAL_LEVEL_ID });
        analytics.countAnonymousTutorialStep('tutorial_complete');
        if (nextLevelId) startLevelFromTutorial(nextLevelId);
        else nav.goLobby({ fade: true }); // exiting a match — one of the transitions that cross-fade
      },
      onExitToLobby() {  // Skip tutorial
        saveManager.setFlag(TUTORIAL_DONE_FLAG, true);
        analytics.track('tutorial_skip', { step: 'tutorial' });
        nav.goLobby({ fade: true }); // exiting a match — one of the transitions that cross-fade
      },
    }, {
      level,
      tutorial: {
        ctaLabel: t(nextLevelId ? 'tutorial.grad.cta' : 'tutorial.grad.ctaReplay'),
        ...(nextLevelId ? { teaser: t('tutorial.grad.teaser', { coins: WELCOME_MAIL_COINS.toLocaleString() }) } : {}),
        onStep(stepKey) {
          analytics.track('tutorial_step', { level_id: TUTORIAL_LEVEL_ID, step_key: stepKey });
          if ((analytics.ANONYMOUS_TUTORIAL_STEPS as readonly string[]).includes(stepKey)) {
            analytics.countAnonymousTutorialStep(stepKey as analytics.AnonymousTutorialStep);
          }
        },
        onBeatDone(info) {
          analytics.track('tutorial_beat_done', { level_id: TUTORIAL_LEVEL_ID, ...info });
        },
      },
    });
  }

  /**
   * Tutorial graduation → the first campaign level, skipping the map and the prep page (one tap from
   * the graduation card, §3.6). Same bookkeeping as LevelPrep's Start: the attempt is tracked and the
   * stamina cost is paid at entry; if stamina somehow does not cover it, fall back to the prep page,
   * which explains why.
   */
  function startLevelFromTutorial(levelId: string): void {
    const level = getLevel(levelId);
    if (!level) { nav.goCampaignMap(); return; }
    analytics.track('level_attempt', { level_id: levelId, stars_before: saveManager.get().progress.stars[levelId] ?? 0 });
    if (!saveManager.spendStaminaForLevel(levelId, level.staminaCost ?? 10)) { nav.goLevelPrep(levelId); return; }
    analytics.track('screen_view', { scene: 'GameScene' });
    nav.goCampaign(levelId);
  }

  return { goTutorial };
}
