// First-session reward loop (ONBOARDING_DESIGN §14.2). New players used to clear the first levels
// and leave without ever touching the meta game: the author welcome mail (1000 coins) sat unclaimed,
// the gacha was never opened, and nothing asked them to come back tomorrow. This drives one short
// pass through all three, once per account:
//   1. clearing ch1_lv2 for the first time routes the win to the lobby (campaignRoster.goCampaign);
//   2. that lobby arrival claims the welcome mail for the player and walks them into one gacha pull;
//   3. the next lobby arrival opens the daily check-in, whose calendar already highlights tomorrow.
// Each step also ticks the anonymous funnel (gift_shown → gift_gacha, daily_shown → daily_open;
// ONBOARDING_DESIGN §14.3), which counts players who never consented to analytics as well.
import * as analytics from '../../analytics';
import type { TranslationKey } from '../../i18n';
import type { SaveManager } from '../../game/meta/SaveManager';
import type { ApiClient } from '../../net/ApiClient';

/** The level whose first clear opens the loop. */
export const REWARD_LOOP_LEVEL = 'ch1_lv2';
/** featSeen ids (SaveManager.featSeen) — one per step, so a step that already ran never repeats. */
export const FIRST_GACHA_FEAT = 'onboard.firstGacha';
export const FIRST_DAILY_FEAT = 'onboard.firstDaily';
/** Subject key of the author welcome mail (server pve/clear.ts, ONBOARDING_DESIGN §5.1). */
const WELCOME_MAIL_SUBJECT = 'mail.welcome.author.subject';
/** Price of one pull in the standard pool — below it there is nothing to walk the player into. */
const FIRST_PULL_COINS = 150;

export interface RewardLoopDeps {
  saveManager: SaveManager;
  client: ApiClient;
  showGuide(titleKey: TranslationKey, bodyKey: TranslationKey, onDismiss: () => void): void;
  goGacha(): void;
  goDaily(): void;
  /** False once the player has left the lobby — an async step must not draw over another scene. */
  stillInLobby(): boolean;
}

/** Whether the win on `levelId` should detour to the lobby to start the loop. */
export function rewardLoopDetour(saveManager: SaveManager, levelId: string, firstClear: boolean): boolean {
  return levelId === REWARD_LOOP_LEVEL && firstClear && !saveManager.featSeen(FIRST_GACHA_FEAT);
}

/** Run whichever step of the loop is due on this lobby arrival (no-op once both have run). */
export function runRewardLoop(deps: RewardLoopDeps): void {
  const { saveManager } = deps;
  if (!saveManager.get().progress.cleared.includes(REWARD_LOOP_LEVEL)) return;
  if (!saveManager.featSeen(FIRST_GACHA_FEAT)) {
    saveManager.markFeatSeen(FIRST_GACHA_FEAT);
    void giftStep(deps);
    return;
  }
  if (!saveManager.featSeen(FIRST_DAILY_FEAT)) {
    saveManager.markFeatSeen(FIRST_DAILY_FEAT);
    saveManager.markFeatSeen('daily'); // this card replaces the lobby button's own first-time guide
    analytics.track('feature_guide_shown', { feature: FIRST_DAILY_FEAT });
    analytics.countAnonymousFunnelStep('daily_shown');
    deps.showGuide('onboard.daily.title', 'onboard.daily.body', () => {
      analytics.countAnonymousFunnelStep('daily_open');
      deps.goDaily();
    });
  }
}

async function giftStep(deps: RewardLoopDeps): Promise<void> {
  const { saveManager, client } = deps;
  try {
    const { mail } = await client.getMail();
    const welcome = mail.find((m) => m.subject === WELCOME_MAIL_SUBJECT && !m.claimed && (m.attachments?.length ?? 0) > 0);
    if (welcome) {
      const { save } = await client.claimMail(welcome.mailId);
      saveManager.adoptServer(save);
      analytics.track('feature_guide_shown', { feature: 'onboard.welcomeMailClaimed' });
    }
  } catch { /* best-effort — the mail stays in the inbox for a manual claim */ }
  if (!deps.stillInLobby() || saveManager.get().wallet.coins < FIRST_PULL_COINS) return;
  saveManager.markFeatSeen('shop'); // the gift card stands in for the shop button's first-time guide
  analytics.track('feature_guide_shown', { feature: FIRST_GACHA_FEAT });
  analytics.countAnonymousFunnelStep('gift_shown');
  deps.showGuide('onboard.gift.title', 'onboard.gift.body', () => {
    analytics.countAnonymousFunnelStep('gift_gacha');
    deps.goGacha();
  });
}
