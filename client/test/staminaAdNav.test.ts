// Level prep's rewarded-ad stamina refill (app/nav/game/staminaAd.ts, CRAZYGAMES_LAUNCH §4):
// offered only where the platform opts in, online, with ad fill; hidden for the rest of the UTC day
// once the server says the refills are used up.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStaminaAd } from '../src/app/nav/game/staminaAd';
import { ApiError } from '../src/net/ApiClient';
import * as log from '../src/net/log';
import type { AppCtx } from '../src/app/appCtx';

const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 8, 27, 12);

function ctx(opts: {
  staminaRewardedAd?: boolean; hasAd?: boolean; online?: boolean;
  ad?: { adToken: string; platform: string } | null;
  adStamina?: () => Promise<{ stamina: { current: number; regenAt: number }; adsLeft: number }>;
} = {}) {
  const save: { stamina?: { current: number; regenAt: number } } = { stamina: { current: 0, regenAt: 0 } };
  const adStamina = vi.fn(opts.adStamina ?? (() => Promise.resolve({ stamina: { current: 30, regenAt: 1 }, adsLeft: 2 })));
  const showRewardedAd = vi.fn(() => Promise.resolve(opts.ad === undefined ? { adToken: 't', platform: 'dev' } : opts.ad));
  const c = {
    api: opts.online === false ? null : { adStamina },
    platform: {
      staminaRewardedAd: opts.staminaRewardedAd ?? true,
      hasRewardedAd: () => opts.hasAd ?? true,
      showRewardedAd,
    },
    saveManager: { get: () => save, update: (fn: (s: typeof save) => void) => fn(save) },
  } as unknown as Pick<AppCtx, 'api' | 'platform' | 'saveManager'>;
  return { c, save, adStamina, showRewardedAd };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('createStaminaAd', () => {
  let toast: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { toast = vi.spyOn(log, 'showToastMessage').mockImplementation(() => {}); });

  it('is not offered without the platform flag, offline, or without ad fill', () => {
    expect(createStaminaAd(ctx({ staminaRewardedAd: false }).c).offer(() => {})).toBeUndefined();
    expect(createStaminaAd(ctx({ online: false }).c).offer(() => {})).toBeUndefined();
    expect(createStaminaAd(ctx({ hasAd: false }).c).offer(() => {})).toBeUndefined();
    expect(createStaminaAd(ctx().c).offer(() => {})).toBeTypeOf('function');
  });

  it('watching mirrors the new stamina and refreshes the screen', async () => {
    const { c, save, adStamina } = ctx();
    const refreshed = vi.fn();
    createStaminaAd(c, () => T0).offer(refreshed)!();
    await flush();
    expect(adStamina).toHaveBeenCalledWith('t', 'dev');
    expect(save.stamina).toEqual({ current: 30, regenAt: 1 });
    expect(refreshed).toHaveBeenCalledOnce();
  });

  it('a closed / unfilled ad grants nothing and does not call the server', async () => {
    const { c, adStamina } = ctx({ ad: null });
    const refreshed = vi.fn();
    createStaminaAd(c, () => T0).offer(refreshed)!();
    await flush();
    expect(adStamina).not.toHaveBeenCalled();
    expect(refreshed).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledOnce();
  });

  it('the last refill of the day hides the offer until the next UTC day', async () => {
    let now = T0;
    const { c } = ctx({ adStamina: () => Promise.resolve({ stamina: { current: 30, regenAt: 1 }, adsLeft: 0 }) });
    const ad = createStaminaAd(c, () => now);
    ad.offer(() => {})!();
    await flush();
    expect(ad.offer(() => {})).toBeUndefined();
    now += DAY;
    expect(ad.offer(() => {})).toBeTypeOf('function');
  });

  it('a 429 from the server also hides it and says why', async () => {
    const { c } = ctx({ adStamina: () => Promise.reject(new ApiError('DAILY_CAP_REACHED', 'cap')) });
    const ad = createStaminaAd(c, () => T0);
    const refreshed = vi.fn();
    ad.offer(refreshed)!();
    await flush();
    expect(ad.offer(() => {})).toBeUndefined();
    expect(refreshed).toHaveBeenCalledOnce(); // redraw drops the button
    expect(toast.mock.calls[0][0]).not.toBe('daily.ads.error');
  });

  it('ignores a second tap while an ad is already playing', async () => {
    const { c, showRewardedAd } = ctx();
    const watch = createStaminaAd(c, () => T0).offer(() => {})!;
    watch(); watch();
    await flush();
    expect(showRewardedAd).toHaveBeenCalledOnce();
  });
});
