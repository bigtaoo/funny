// Tutorial navigation: the dedicated tutorial level ch0_tutorial and its graduation hand-off into the
// first campaign level (ONBOARDING_DESIGN §3.6 / §11). Split out of campaignRoster.ts (500-line rule);
// it reaches the campaign entry points through the shared `nav` registry like every other factory.
import * as analytics from '../../../analytics';
import { getLevel, CAMPAIGN_LEVEL_ORDER } from '../../../game';
import { TUTORIAL_LEVEL_ID } from '@nw/engine';
import { WELCOME_MAIL_COINS } from '@nw/shared/onboarding';
import { t, type TranslationKey } from '../../../i18n';
import type { AppCtx, Nav } from '../../appCtx';
import { TUTORIAL_BEATS_DONE_FLAG, TUTORIAL_DONE_FLAG } from '../../appConstants';
import { levelStaminaCost } from './staminaCost';
import { CHAIN_AUTO_SEC } from './nextLevel';
import { anonLevelStep } from './campaignResult';

type TutorialNav = Pick<Nav, 'goTutorial'>;

/**
 * Graduation card auto-continue (ONBOARDING_DESIGN §13): players who went on tapped within 2 s, p90 4 s.
 * Shortened 4 → 2.5 s (6 → 4 s with the analytics notice) in §15.7 — the card is a pause between the
 * tutorial and level 1, and every second there was a second some players spent leaving.
 */
const GRAD_AUTO_SEC = 2.5;
const GRAD_AUTO_NOTICE_SEC = 4;

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
   * already cleared a level, just returns to the lobby. Skip goes the same way: into ch1_lv1 on a fresh
   * account, otherwise back to the lobby (§13).
   *
   * Every step also ticks the anonymous first-session funnel counter, which counts every player
   * whatever their analytics answer — the one funnel that also covers unconsented players
   * (ANALYTICS_DESIGN §3.6d).
   */
  function goTutorial(): void {
    const level = getLevel(TUTORIAL_LEVEL_ID);
    if (!level) { nav.goLobby(); return; }  // If the tutorial level is missing, skip silently rather than blocking new players.
    state.inLobby = false;
    const firstLevelId = CAMPAIGN_LEVEL_ORDER[0];
    const freshAccount = !saveManager.getFlag(TUTORIAL_DONE_FLAG) && saveManager.get().progress.cleared.length === 0;
    const nextLevelId = freshAccount && firstLevelId && getLevel(firstLevelId) ? firstLevelId : null;
    // Resume (§17.7): left during the free fight last time — the beats are learned, so go on to the
    // first real level instead of replaying a two-minute tutorial from its first beat.
    if (nextLevelId && saveManager.getFlag(TUTORIAL_BEATS_DONE_FLAG)) {
      saveManager.setFlag(TUTORIAL_DONE_FLAG, true);
      analytics.track('tutorial_skip', { step: 'resume' });
      startLevelFromTutorial(nextLevelId);
      return;
    }
    platform.onGameplayStart();
    analytics.track('tutorial_start', { level_id: TUTORIAL_LEVEL_ID });
    analytics.countAnonymousFunnelStep('tutorial_start');
    // With the analytics notice the graduation card is up and its button already said "next level";
    // without it the WIN stamp leaves on its own and the chain banner names what comes next (§17.3).
    const withCard = ctx.statsNoticePending?.() ?? false;
    views.showGame({
      onGameEnd(_winner, _stats, _replay, _summary, banner) {
        saveManager.setFlag(TUTORIAL_DONE_FLAG, true);
        analytics.track('tutorial_complete', { level_id: TUTORIAL_LEVEL_ID });
        analytics.countAnonymousFunnelStep('tutorial_complete');
        const next = nextLevelId ? getLevel(nextLevelId) : null;
        if (nextLevelId && next && banner && !withCard) {
          platform.onGameplayStop(); // goCampaign sends the matching start
          banner.showChainBanner({
            nextName: t(next.nameKey as TranslationKey),
            autoSec: CHAIN_AUTO_SEC,
            onNext: (auto) => startLevelFromTutorial(nextLevelId, auto),
            onMap: () => nav.goCampaignMap(),
          });
          return;
        }
        if (nextLevelId) startLevelFromTutorial(nextLevelId);
        else nav.goLobby({ fade: true }); // exiting a match — one of the transitions that cross-fade
      },
      onExitToLobby() {  // Skip tutorial
        saveManager.setFlag(TUTORIAL_DONE_FLAG, true);
        analytics.track('tutorial_skip', { step: 'tutorial' });
        analytics.countAnonymousFunnelStep('tutorial_skip');
        // A fresh account skips into the same first fight graduation leads to (ONBOARDING_DESIGN
        // §13): in the first CrazyGames week, most skippers who landed in the lobby closed the tab.
        if (nextLevelId) startLevelFromTutorial(nextLevelId);
        else nav.goLobby({ fade: true }); // exiting a match — one of the transitions that cross-fade
      },
    }, {
      level,
      tutorial: {
        ctaLabel: t(nextLevelId ? 'tutorial.grad.cta' : 'tutorial.grad.ctaReplay'),
        ...(nextLevelId ? { teaser: t('tutorial.grad.teaser', { coins: WELCOME_MAIL_COINS.toLocaleString() }) } : {}),
        // Only where the button leads on into ch1_lv1 (ONBOARDING_DESIGN §13); longer while the
        // analytics notice rides on the card, so it stays up long enough to be read.
        ...(nextLevelId ? { autoContinueSec: ctx.statsNoticePending?.() ? GRAD_AUTO_NOTICE_SEC : GRAD_AUTO_SEC } : {}),
        // Notice-only build, outside the EEA: the analytics notice rides on the card, so a player who
        // plays straight on into level 1 has seen it within the first minute (COMPLIANCE_GLOBAL §3.3b).
        ...(ctx.statsNoticePending?.() ? {
          footnote: t('entryNotice.stats'),
          onFootnoteShown: () => ctx.acknowledgeStatsNotice?.(),
        } : {}),
        lastSpawnTick: Math.max(...level.waves.entries.map((e) => e.atTick + (e.count - 1) * (e.spacingTicks ?? 0))),
        onStep(stepKey) {
          if (stepKey === 'graduate') saveManager.setFlag(TUTORIAL_BEATS_DONE_FLAG, true);
          analytics.track('tutorial_step', { level_id: TUTORIAL_LEVEL_ID, step_key: stepKey });
          if ((analytics.ANONYMOUS_FUNNEL_STEPS as readonly string[]).includes(stepKey)) {
            analytics.countAnonymousFunnelStep(stepKey as analytics.AnonymousFunnelStep);
          }
        },
        onBeatDone(info) {
          analytics.track('tutorial_beat_done', { level_id: TUTORIAL_LEVEL_ID, ...info });
        },
        onIdlePrompt(info) {
          analytics.track('tutorial_idle_prompt', { level_id: TUTORIAL_LEVEL_ID, ...info });
          analytics.countAnonymousFunnelStep(info.outcome === 'shown' ? 'free_idle_prompt' : 'free_idle_resume');
        },
      },
    });
  }

  /**
   * Tutorial graduation → the first campaign level, skipping the map and the prep page (one tap from
   * the graduation card, §3.6). Same bookkeeping as LevelPrep's Start: the attempt is tracked and the
   * stamina cost is paid at entry; if stamina somehow does not cover it, fall back to the prep page,
   * which explains why. `auto` is set when the chain banner started it: its countdown ran out (true)
   * or the player tapped (false).
   */
  function startLevelFromTutorial(levelId: string, auto?: boolean): void {
    const level = getLevel(levelId);
    if (!level) { nav.goCampaignMap(); return; }
    analytics.track('level_attempt', {
      level_id: levelId,
      stars_before: saveManager.get().progress.stars[levelId] ?? 0,
      ...(auto !== undefined ? { chained: true, auto } : {}),
    });
    if (!saveManager.spendStaminaForLevel(levelId, levelStaminaCost(platform, level))) { nav.goLevelPrep(levelId); return; }
    const autoStep = auto ? anonLevelStep(levelId, saveManager.get().progress.cleared, 'auto') : null;
    if (autoStep) analytics.countAnonymousFunnelStep(autoStep);
    analytics.track('screen_view', { scene: 'GameScene' });
    nav.goCampaign(levelId);
  }

  return { goTutorial };
}
