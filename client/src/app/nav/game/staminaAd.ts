// Rewarded-ad stamina refill on level prep (CRAZYGAMES_LAUNCH §4). Only offered where the platform
// opts in (`IPlatform.staminaRewardedAd`, CrazyGames only) and has a live ad integration; the server
// (`POST /pve/stamina/ad`) enforces the same platform scope and the daily cap.
import * as analytics from '../../../analytics';
import { t } from '../../../i18n';
import { ApiError } from '../../../net/ApiClient';
import { showToastMessage } from '../../../net/log';
import type { AppCtx } from '../../appCtx';

/** UTC day, matching the server's counter reset (`adsDayKey`). */
function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface StaminaAd {
  /**
   * The level-prep callback, or undefined when no ad refill is on offer (wrong platform, offline,
   * no ad fill, or today's refills used up). `onRefilled` runs after the new stamina is mirrored.
   */
  offer(onRefilled: () => void): (() => void) | undefined;
}

export function createStaminaAd(
  ctx: Pick<AppCtx, 'api' | 'platform' | 'saveManager'>,
  now: () => number = Date.now,
): StaminaAd {
  const { api, platform, saveManager } = ctx;
  /** Day on which the cap was reached: the button stays hidden for the rest of it. */
  let usedUpDay: string | null = null;
  let busy = false;

  async function watch(onRefilled: () => void): Promise<void> {
    if (!api || busy) return;
    busy = true;
    try {
      const ad = await platform.showRewardedAd(saveManager.get()?.accountId ?? '');
      if (!ad) { showToastMessage(t('daily.ads.unavailable'), 'error'); return; }
      const { stamina, adsLeft } = await api.adStamina(ad.adToken, ad.platform);
      saveManager.update((s) => { s.stamina = stamina; });
      if (adsLeft <= 0) usedUpDay = utcDay(now());
      analytics.track('ads_reward', { kind: 'stamina', stamina_after: stamina.current, ads_left: adsLeft, platform: ad.platform });
      onRefilled();
    } catch (e) {
      const capped = e instanceof ApiError && e.code === 'DAILY_CAP_REACHED';
      if (capped) { usedUpDay = utcDay(now()); onRefilled(); }
      showToastMessage(t(capped ? 'stamina.adCapReached' : 'daily.ads.error'), 'error');
    } finally {
      busy = false;
    }
  }

  return {
    offer(onRefilled) {
      if (!api || !platform.staminaRewardedAd || !platform.hasRewardedAd()) return undefined;
      if (usedUpDay === utcDay(now())) return undefined;
      return () => void watch(onRefilled);
    },
  };
}
