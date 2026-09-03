// The two native-shell bridge readers — `platform/iap.ts`'s `getNativeBilling()` and
// `platform/nativeAds.ts`'s `getNativeAds()` — plus the one routing decision each of them feeds.
//
// **These had zero cases anywhere in the repo before this file** (2026-09-02): `NWBilling`,
// `NWAds` and `requestPlatformHeader` appeared in no test under `client/test/`, and neither
// module is inside `coverage.include`, so nothing measured them either. That is the same shape
// `src/audio/**` was in when the two SFX buses turned out to be 0% in every suite (see
// `ContextAudioBus.test.ts`'s header): a small file whose only job is to answer a question, so
// "it's only 30 lines" reads as a reason to skip it right up until one of the answers is wrong.
//
// What makes them worth cases rather than a glance is that BOTH failure directions are silent:
//
//   • a bridge that fails the shape check is indistinguishable from no bridge at all, so a
//     native iOS shell shipping a malformed `window.NWBilling` doesn't error — it quietly
//     becomes a *Paddle* build (web checkout inside a WKWebView, which Apple rejects) and
//     declares itself as platform `web` to the server, i.e. it spends from the wrong
//     recharged-pool bucket (ADR-020 / `spendChannel.ts`).
//   • a bridge that passes the shape check but was never injected on this platform can't
//     happen — which is exactly why the check has to stay strict rather than truthy.
//
// So every case below asserts on the routing *answer* (`'ios'` / `'android'` / `'web'`,
// bridge-or-null), never on the absence of a throw.
//
// Run with: npm test
import { describe, it, expect, afterEach } from 'vitest';
import { getNativeBilling, type NwBillingBridge } from '../src/platform/iap';
import { getNativeAds, type NwAdsBridge } from '../src/platform/nativeAds';
import { requestPlatformHeader } from '../src/net/ApiClient/core';

type Globals = {
  NWBilling?: unknown;
  NWAds?: unknown;
  TARGET?: string;
};

const g = globalThis as Globals;

/** Install a `window.NWBilling` of arbitrary (possibly malformed) shape. */
function setBilling(v: unknown): void { g.NWBilling = v; }
/** Install a `window.NWAds` of arbitrary (possibly malformed) shape. */
function setAds(v: unknown): void { g.NWAds = v; }

/** A well-formed native billing bridge. `purchase` records what it was asked to buy. */
function goodBilling(kind: 'apple' | 'google'): NwBillingBridge & { asked: string[] } {
  const asked: string[] = [];
  return {
    kind,
    asked,
    purchase(tierId: string) { asked.push(tierId); return Promise.resolve({ receipt: `r:${tierId}` }); },
  };
}

/** A well-formed native ads bridge. `asked` records the accountIds it was handed. */
function goodAds(): NwAdsBridge & { asked: string[] } {
  const asked: string[] = [];
  return {
    kind: 'admob',
    asked,
    showRewarded(accountId: string) {
      asked.push(accountId);
      return Promise.resolve({ adToken: `t:${accountId}`, platform: 'admob_client' as const });
    },
  };
}

afterEach(() => {
  delete g.NWBilling;
  delete g.NWAds;
  delete g.TARGET;
});

describe('getNativeBilling — the shape check is the whole feature', () => {
  it('no global at all → null (the plain-browser case, i.e. Paddle)', () => {
    expect(getNativeBilling()).toBeNull();
  });

  it('a well-formed apple bridge is returned as-is, callable', async () => {
    const b = goodBilling('apple');
    setBilling(b);
    const got = getNativeBilling();
    expect(got).toBe(b);
    await got!.purchase('t499');
    expect(b.asked).toEqual(['t499']);
  });

  it('a well-formed google bridge is returned as-is', () => {
    const b = goodBilling('google');
    setBilling(b);
    expect(getNativeBilling()).toBe(b);
  });

  // The four rejection branches. Each one is a shell-side bug that must degrade to "no bridge"
  // rather than to a half-working purchase path.
  it('rejects a bridge whose kind is not a store this client can verify receipts for', () => {
    setBilling({ kind: 'stripe', purchase: () => Promise.resolve({ receipt: 'x' }) });
    expect(getNativeBilling()).toBeNull();
  });

  it('rejects a bridge with no purchase method (kind alone is not a bridge)', () => {
    setBilling({ kind: 'apple' });
    expect(getNativeBilling()).toBeNull();
  });

  it('rejects a bridge whose purchase is present but not callable', () => {
    setBilling({ kind: 'apple', purchase: 'yes' });
    expect(getNativeBilling()).toBeNull();
  });

  it('rejects a null / non-object global without throwing on the property reads', () => {
    setBilling(null);
    expect(getNativeBilling()).toBeNull();
    setBilling(0);
    expect(getNativeBilling()).toBeNull();
    setBilling('NWBilling');
    expect(getNativeBilling()).toBeNull();
  });
});

describe('getNativeAds — same contract, AdMob instead of StoreKit', () => {
  it('no global at all → null (plain web / WeChat: WebPlatform.hasRewardedAd() is false there)', () => {
    expect(getNativeAds()).toBeNull();
  });

  it('a well-formed admob bridge is returned as-is, and is handed the accountId for SSV', async () => {
    const a = goodAds();
    setAds(a);
    const got = getNativeAds();
    expect(got).toBe(a);
    // The accountId is the whole point of the argument: it rides to the native side as the SSV
    // customRewardText so `/ads/callback/admob` can credit the right account.
    await got!.showRewarded('acc-7');
    expect(a.asked).toEqual(['acc-7']);
  });

  it('rejects a non-admob kind', () => {
    setAds({ kind: 'unityads', showRewarded: () => Promise.resolve({ adToken: 'x', platform: 'admob_client' }) });
    expect(getNativeAds()).toBeNull();
  });

  it('rejects a bridge with no showRewarded, or a non-callable one', () => {
    setAds({ kind: 'admob' });
    expect(getNativeAds()).toBeNull();
    setAds({ kind: 'admob', showRewarded: 1 });
    expect(getNativeAds()).toBeNull();
  });

  it('rejects a null / non-object global', () => {
    setAds(null);
    expect(getNativeAds()).toBeNull();
    setAds(false);
    expect(getNativeAds()).toBeNull();
  });
});

// `requestPlatformHeader()` is the consumer that turns the bridge into a wire value. It is the
// reason the shape check above is not cosmetic: the header picks which recharged-pool bucket the
// session may spend from, so getting it wrong is a commerce bug, not a cosmetic one.
describe('requestPlatformHeader — X-NW-Platform (ADR-020)', () => {
  it('an apple bridge declares ios, a google bridge declares android', () => {
    setBilling(goodBilling('apple'));
    expect(requestPlatformHeader()).toBe('ios');
    setBilling(goodBilling('google'));
    expect(requestPlatformHeader()).toBe('android');
  });

  it('the native bridge WINS over the build-time TARGET (mobile reuses the web bundle)', () => {
    // This is the ordering the doc comment on requestPlatformHeader promises: TARGET can only ever
    // say "web" for a Capacitor shell, because the shell ships the web build.
    g.TARGET = 'web';
    setBilling(goodBilling('apple'));
    expect(requestPlatformHeader()).toBe('ios');
  });

  it('no bridge → falls back to the build-time TARGET', () => {
    expect(requestPlatformHeader()).toBe('web');          // TARGET unset
    g.TARGET = 'wechat';
    expect(requestPlatformHeader()).toBe('wechat');
    g.TARGET = 'crazygames';
    expect(requestPlatformHeader()).toBe('crazygames');
  });

  it('a MALFORMED bridge falls back to TARGET rather than guessing a store', () => {
    // The silent-failure case spelled out in this file's header: a native shell whose injected
    // bridge is broken reports itself as a web session. That is the deliberate choice — the
    // alternative (trusting `kind` without checking `purchase`) would declare `ios` for a session
    // that cannot actually complete a StoreKit purchase. Pinned so the strictness can't be
    // "simplified" away later.
    g.TARGET = 'web';
    setBilling({ kind: 'apple' });
    expect(requestPlatformHeader()).toBe('web');
    setBilling({ kind: 'apple', purchase: null });
    expect(requestPlatformHeader()).toBe('web');
  });
});
