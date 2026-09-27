/**
 * CrazyGames Basic Launch obligations that live inside CrazyGamesPlatform
 * (design/game/CRAZYGAMES_LAUNCH.md §2): the v3 loading-window calls, no ad surface while the portal
 * serves no ads (Basic Launch, adblock), and the portal's language with an English fallback.
 *
 * The SDK double below mirrors the v3 SDK's own behaviour, checked against
 * https://sdk.crazygames.com/crazygames-sdk-v3.js: `prefetchAd` throws an AdError whose `code` is
 * 'adsDisabledBasicLaunch' during Basic Launch, and the v2 `sdkGameLoadingStart/Stop` names no
 * longer exist as methods — the previous test here stubbed those v2 names and so passed while the
 * real calls were silent no-ops.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectLocale } from '../src/i18n';

function stubMinimalDom(sdk?: unknown): void {
  const fakeCanvas = { id: '', style: {} } as unknown as HTMLCanvasElement;
  vi.stubGlobal('document', {
    getElementById: () => null,
    createElement: () => fakeCanvas,
    body: { appendChild: () => {}, style: {} },
  });
  vi.stubGlobal('window', {
    devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720,
    ...(sdk ? { CrazyGames: { SDK: sdk } } : {}),
  });
  const kv = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => kv.get(k) ?? null,
    setItem: (k: string, v: string) => { kv.set(k, v); },
    removeItem: (k: string) => { kv.delete(k); },
  });
  vi.stubGlobal('navigator', { language: 'fr-FR' });
}

interface SdkOpts { basic?: boolean; adblock?: boolean; locale?: string; calls?: string[] }

function fakeSdk(o: SdkOpts = {}) {
  const calls = o.calls ?? [];
  return {
    init: () => { calls.push('init'); return Promise.resolve(); },
    game: {
      gameplayStart: () => {}, gameplayStop: () => {},
      loadingStart: () => calls.push('start'),
      loadingStop: () => calls.push('stop'),
    },
    ad: {
      requestAd: (type: string, cb: { adError?(e: unknown): void }) => {
        calls.push(`request:${type}`);
        if (o.basic) cb.adError?.({ code: 'adsDisabledBasicLaunch' });
      },
      prefetchAd: (type: string) => {
        if (o.basic) throw Object.assign(new Error('Ads are disabled during basic launch'), { code: 'adsDisabledBasicLaunch' });
        calls.push(`prefetch:${type}`);
      },
      hasAdblock: () => Promise.resolve(!!o.adblock),
    },
    user: {
      systemInfo: o.locale ? { locale: o.locale } : {},
      getUserToken: () => Promise.resolve('portal-jwt'),
    },
  };
}

async function boot(o: SdkOpts = {}) {
  stubMinimalDom(fakeSdk(o));
  const { CrazyGamesPlatform } = await import('../src/platform/crazygames/CrazyGamesPlatform');
  const platform = new CrazyGamesPlatform();
  await platform.onLoadingComplete();
  await Promise.resolve(); // let the hasAdblock() answer land
  return platform;
}

describe('CrazyGamesPlatform — Basic Launch obligations', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('REGRESSION: opens the loading window with the v3 names while still loading, then closes it', async () => {
    const calls: string[] = [];
    await boot({ calls });
    expect(calls.filter((c) => !c.startsWith('prefetch'))).toEqual(['init', 'start', 'stop']);
  });

  it('a host without the SDK (our own dev server) is a no-op, not a throw, and offers no ads', async () => {
    stubMinimalDom();
    const { CrazyGamesPlatform } = await import('../src/platform/crazygames/CrazyGamesPlatform');
    const platform = new CrazyGamesPlatform();
    await expect(platform.onLoadingComplete()).resolves.toBeUndefined();
    expect(platform.hasRewardedAd()).toBe(false);
  });

  it('Basic Launch: no rewarded-ad tab, and midgame ads are not even requested', async () => {
    const calls: string[] = [];
    const platform = await boot({ basic: true, calls });
    expect(platform.hasRewardedAd()).toBe(false);
    await platform.showMidgameAd();
    expect(calls).not.toContain('request:midgame');
  });

  it('Full Launch: the rewarded-ad tab is offered and midgame ads are requested', async () => {
    const calls: string[] = [];
    const platform = await boot({ calls });
    expect(platform.hasRewardedAd()).toBe(true);
    void platform.showMidgameAd();
    expect(calls).toContain('request:midgame');
  });

  it('an ad-blocked player gets no rewarded-ad tab rather than a button that always fails', async () => {
    const platform = await boot({ adblock: true });
    expect(platform.hasRewardedAd()).toBe(false);
  });

  it('reads the language from the portal, not the browser', async () => {
    const platform = await boot({ locale: 'de-DE' });
    expect(platform.getLanguage()).toBe('de-DE');
    expect(detectLocale(platform.getLanguage(), platform.supportedLocales)).toBe('de');
  });

  it('a language we do not ship falls back to English (the portal requirement), not Chinese', async () => {
    const platform = await boot({ locale: 'fr-FR' });
    expect(detectLocale(platform.getLanguage(), platform.supportedLocales)).toBe('en');
  });

  it('declinePortalIdentity: the rest of the session authenticates as the device guest', async () => {
    const platform = await boot();
    expect((await platform.getAuthCredential()).kind).toBe('crazygames');
    expect(platform.declinePortalIdentity(), 'there was a portal identity to give up').toBe(true);
    expect((await platform.getAuthCredential()).kind).toBe('device');
    expect(platform.declinePortalIdentity(), 'nothing left to decline — no second retry').toBe(false);
  });
});
