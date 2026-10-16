// Next-day hero gift, lobby side (ONBOARDING_DESIGN §17.4). The first ch1_lv3 clear earns the trial
// hero for keeps from the next UTC midnight (server pve/heroGift.ts); the battle and the result screen
// already said so. The first lobby arrival once it is due claims it and says so, then opens the roster
// where the card now sits. Before it is due, the lobby's Campaign pillar carries a countdown sticker
// (scenes/LobbyScene/heroGiftSticker.ts) that claims it the moment it runs out.
import * as analytics from '../../analytics';
import type { TranslationKey } from '../../i18n';
import type { SaveManager } from '../../game/meta/SaveManager';
import type { ApiClient } from '../../net/ApiClient';
import type { SaveData } from '../../game/meta/SaveData';

export interface HeroGiftDeps {
  saveManager: SaveManager;
  client: ApiClient;
  showGuide(titleKey: TranslationKey, bodyKey: TranslationKey, onDismiss: () => void): void;
  goRoster(): void;
  /** False once the player has left the lobby — an async step must not draw over another scene. */
  stillInLobby(): boolean;
  /** Server-synced clock — `claimableAt` is a server timestamp, and a fast local clock would claim early and 400. */
  now(): number;
}

/** When the earned-but-unclaimed gift becomes claimable, or null when there is none. */
export function pendingHeroGiftAt(save: SaveData): number | null {
  const gift = save.heroGift;
  return gift && gift.claimedAt === undefined ? gift.claimableAt : null;
}

/** Whether this lobby arrival claims the gift — true means it took the arrival's one guide slot. */
export function runHeroGift(deps: HeroGiftDeps): boolean {
  const at = pendingHeroGiftAt(deps.saveManager.get());
  if (at === null || deps.now() < at) return false;
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
