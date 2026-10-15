// Next-day hero gift, lobby side (ONBOARDING_DESIGN §17.4). The first ch1_lv5 clear earns the trial
// hero for keeps from the next UTC midnight (server pve/heroGift.ts); the battle and the result screen
// already said so. The first lobby arrival once it is due claims it and says so, then opens the roster
// where the card now sits.
import * as analytics from '../../analytics';
import type { TranslationKey } from '../../i18n';
import type { SaveManager } from '../../game/meta/SaveManager';
import type { ApiClient } from '../../net/ApiClient';

export interface HeroGiftDeps {
  saveManager: SaveManager;
  client: ApiClient;
  showGuide(titleKey: TranslationKey, bodyKey: TranslationKey, onDismiss: () => void): void;
  goRoster(): void;
  /** False once the player has left the lobby — an async step must not draw over another scene. */
  stillInLobby(): boolean;
  now(): number;
}

/** Whether this lobby arrival claims the gift — true means it took the arrival's one guide slot. */
export function runHeroGift(deps: HeroGiftDeps): boolean {
  const gift = deps.saveManager.get().heroGift;
  if (!gift || gift.claimedAt !== undefined || deps.now() < gift.claimableAt) return false;
  void claim(deps);
  return true;
}

async function claim(deps: HeroGiftDeps): Promise<void> {
  try {
    const { save } = await deps.client.claimHeroGift();
    deps.saveManager.adoptServer(save);
  } catch {
    return; // best-effort — the next lobby arrival tries again
  }
  analytics.track('feature_guide_shown', { feature: 'onboard.heroGift' });
  if (!deps.stillInLobby()) return;
  deps.showGuide('heroGift.claimed.title', 'heroGift.claimed.body', () => deps.goRoster());
}
