/**
 * nativePaymentIsolation.test.ts — the web payment channel must be unreachable from a store build.
 *
 * Apple's guideline 3.1.1 does not care that our routing code *intends* to use StoreKit; it cares
 * what a reviewer (or a player) can reach inside the shipped app. Four separate things had to be
 * true for that, and on 2026-09-03 three of them were false while every existing test stayed green,
 * because each failure is silent — nothing throws, nothing looks broken, the app just quietly
 * becomes a web-commerce app wearing a native shell:
 *
 *   1. `iapKind()` fell back to `'paddle'` whenever `window.NWBilling` was absent. The bridge is
 *      injected by a view controller wired through Main.storyboard's customClass, so losing that
 *      wiring (a `cap sync`, a Capacitor major) turns the App Store build into a Paddle build.
 *   2. `requestPlatformHeader()` had the same fallback, declaring `web` — so the same broken shell
 *      would also spend from the *web* recharged bucket (ADR-020 cross-channel leak).
 *   3. The build copied `pay.html` (which loads paddle.js and opens a live checkout), `pricing.html`,
 *      `refunds.html` and `home.html` into the `mobile` bundle, i.e. into the iOS binary and every
 *      OTA update — with `terms.html` → `refunds.html` reachable from the in-app consent gate.
 *   4. The StoreKit bridge asked for `<bundle>.coins.monthly_card` and friends, product ids that
 *      exist in no App Store Connect account and that the server could not have resolved anyway.
 *
 * So the cases below are all "what does the build/route actually answer", never "does it throw".
 * The bridge's own shape check has its cases in nativeBridges.test.ts; this file is about what
 * happens when that check says no *inside the shell*, which is the case that used to be wrong.
 *
 * Run with: npm test
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

// Capacitor is the one signal that survives a broken bridge (src/platform/nativeShell.ts), so it is
// the boundary the shell is faked at here — mocking nativeShell itself would test nothing.
const cap = vi.hoisted(() => ({ platform: 'web', throws: false }));
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => { if (cap.throws) throw new Error('capacitor runtime unavailable'); return cap.platform; },
    isNativePlatform: () => cap.platform !== 'web',
  },
}));

type Globals = { NWBilling?: unknown; TARGET?: string };
const g = globalThis as Globals;

/** A well-formed native billing bridge, as AppDelegate.swift injects it. */
function goodBilling(kind: 'apple' | 'google'): unknown {
  return { kind, purchase: (tierId: string) => Promise.resolve({ receipt: `r:${tierId}` }) };
}

/** The minimal DOM WebPlatform's constructor touches (same shape paddleCheckoutRace.test.ts uses). */
function stubMinimalDom(): void {
  const fakeCanvas = { id: '', style: {} } as unknown as HTMLCanvasElement;
  vi.stubGlobal('document', {
    getElementById: () => null,
    createElement: () => fakeCanvas,
    body: { appendChild: () => {}, style: {} },
    head: { appendChild: () => {} },
    querySelector: () => null,
  });
  vi.stubGlobal('window', { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720 });
  vi.stubGlobal('localStorage', new Map<string, string>());
  vi.stubGlobal('navigator', { language: 'en' });
}

beforeEach(() => {
  cap.platform = 'web';
  cap.throws = false;
});

afterEach(() => {
  delete g.NWBilling;
  delete g.TARGET;
  vi.unstubAllGlobals();
});

describe('nativeShell() — "am I in the shell?", answered without our own wiring', () => {
  it('reports the shell Capacitor reports', async () => {
    const { nativeShell, isNativeShell } = await import('../src/platform/nativeShell');
    cap.platform = 'ios';
    expect(nativeShell()).toBe('ios');
    expect(isNativeShell()).toBe(true);
    cap.platform = 'android';
    expect(nativeShell()).toBe('android');
    cap.platform = 'web';
    expect(nativeShell()).toBeNull();
    expect(isNativeShell()).toBe(false);
  });

  it('an unknown or throwing runtime answers "not native", never a guessed store', async () => {
    const { nativeShell } = await import('../src/platform/nativeShell');
    cap.platform = 'electron';
    expect(nativeShell()).toBeNull();
    cap.throws = true;
    expect(nativeShell()).toBeNull();
  });
});

describe('WebPlatform.iapKind() — a store build never routes to Paddle', () => {
  beforeEach(() => { stubMinimalDom(); });

  it('plain browser, no bridge → paddle (the web channel, unchanged)', async () => {
    const { WebPlatform } = await import('../src/platform/web/WebPlatform');
    expect(new WebPlatform().iapKind()).toBe('paddle');
  });

  it('shell + working bridge → that bridge\'s store', async () => {
    const { WebPlatform } = await import('../src/platform/web/WebPlatform');
    cap.platform = 'ios';
    g.NWBilling = goodBilling('apple');
    expect(new WebPlatform().iapKind()).toBe('apple');
  });

  it('REGRESSION: shell with NO bridge → null, not paddle', async () => {
    // The whole point. A store build that cannot sell hides its recharge entry points (the shop nav
    // gates every one of them on `iapKind() !== null`) — which is a bug to fix, and survivable.
    // A store build that sells through Paddle is an app that gets pulled.
    const { WebPlatform } = await import('../src/platform/web/WebPlatform');
    cap.platform = 'ios';
    expect(new WebPlatform().iapKind()).toBeNull();
    cap.platform = 'android';
    expect(new WebPlatform().iapKind()).toBeNull();
  });

  it('REGRESSION: shell with a MALFORMED bridge → null (fails the shape check, still not paddle)', async () => {
    const { WebPlatform } = await import('../src/platform/web/WebPlatform');
    cap.platform = 'ios';
    g.NWBilling = { kind: 'apple' };                    // no purchase()
    expect(new WebPlatform().iapKind()).toBeNull();
    g.NWBilling = { kind: 'stripe', purchase: () => Promise.resolve({ receipt: 'x' }) };
    expect(new WebPlatform().iapKind()).toBeNull();
  });
});

describe('WebPlatform.openPaddleCheckout() — the second lock, at the point paddle.js would load', () => {
  beforeEach(() => { stubMinimalDom(); });

  it('rejects inside the shell instead of injecting paddle.js into the WKWebView', async () => {
    const { WebPlatform } = await import('../src/platform/web/WebPlatform');
    cap.platform = 'ios';
    await expect(new WebPlatform().openPaddleCheckout('tx1', 'test_token')).rejects.toThrow(/native shell/);
  });
});

describe('requestPlatformHeader() — X-NW-Platform when the bridge is gone (ADR-020)', () => {
  it('REGRESSION: a bridgeless shell declares its own platform, not web', async () => {
    const { requestPlatformHeader } = await import('../src/net/ApiClient/core');
    g.TARGET = 'web';                                    // what the mobile build's TARGET reads as
    cap.platform = 'ios';
    expect(requestPlatformHeader()).toBe('ios');
    cap.platform = 'android';
    expect(requestPlatformHeader()).toBe('android');
  });

  it('the bridge still wins when present, and a browser still reports its TARGET', async () => {
    const { requestPlatformHeader } = await import('../src/net/ApiClient/core');
    cap.platform = 'ios';
    g.NWBilling = goodBilling('apple');
    expect(requestPlatformHeader()).toBe('ios');
    delete g.NWBilling;
    cap.platform = 'web';
    g.TARGET = 'crazygames';
    expect(requestPlatformHeader()).toBe('crazygames');
  });
});

// ── Build wiring: what is actually inside the app binary ────────────────────────────────────────
// Same approach as capacitorStubs.test.ts — read the real config, since the contract is invisible
// at runtime (nothing links to these pages from the game; they ride along in dist/ regardless).
const CLIENT_DIR = path.resolve(__dirname, '..');
const requireJs = createRequire(path.join(__dirname, 'nativePaymentIsolation.test.ts'));
type ConfigFactory = (env: { TARGET: string }, argv: { mode: string }) => { plugins: unknown[] };
const configFactory = requireJs('../webpack.config.js') as ConfigFactory;

/** Every file the given target's CopyPlugins copy into dist, client-relative with forward slashes. */
function copiedFiles(target: string): string[] {
  const { plugins } = configFactory({ TARGET: target }, { mode: 'development' });
  return plugins
    .filter((p): p is { constructor: { name: string }; patterns: { from: string }[] } =>
      !!p && (p as { constructor?: { name?: string } }).constructor?.name === 'CopyPlugin')
    .flatMap((p) => p.patterns.map((pat) => pat.from.replace(/\\/g, '/')));
}

/** The module swaps the given target builds with, as `{ from (regex source), to }` client-relative pairs. */
function moduleReplacements(target: string): { from: string; to: string }[] {
  const { plugins } = configFactory({ TARGET: target }, { mode: 'development' });
  return plugins
    .filter((p): p is { constructor: { name: string }; resourceRegExp: RegExp; newResource: unknown } =>
      !!p && (p as { constructor?: { name?: string } }).constructor?.name === 'NormalModuleReplacementPlugin')
    .filter((p) => typeof p.newResource === 'string')   // the `.hires` art swap rewrites from a callback
    .map((p) => ({
      from: String(p.resourceRegExp),
      to: path.relative(CLIENT_DIR, p.newResource as string).replace(/\\/g, '/'),
    }));
}

describe('the mobile bundle carries no web payment surface', () => {
  // pay.html is the sharpest one — it is a working Paddle checkout, not a description of one.
  const WEB_COMMERCE_PAGES = ['pay.html', 'pricing.html', 'refunds.html', 'home.html', 'terms.html', 'privacy.html'];

  it('REGRESSION: the mobile build copies none of the web pages', () => {
    const copied = copiedFiles('mobile');
    for (const page of WEB_COMMERCE_PAGES) {
      expect(copied.some((f) => f.endsWith(`/${page}`)), `mobile bundle must not ship ${page}`).toBe(false);
    }
  });

  it('the web build still copies all of them (this is their home, and Paddle crawls them)', () => {
    const copied = copiedFiles('web');
    for (const page of WEB_COMMERCE_PAGES) {
      expect(copied.some((f) => f.endsWith(`/${page}`)), `web bundle must ship ${page}`).toBe(true);
    }
  });

  it('branding icons are not commerce and stay on every non-wechat target', () => {
    for (const target of ['web', 'mobile', 'crazygames']) {
      expect(copiedFiles(target)).toContain('public/site.webmanifest');
      expect(copiedFiles(target)).toContain('public/apple-touch-icon.png');
    }
  });

  it('the mobile build swaps the Paddle checkout module itself for a throwing stub', () => {
    // The runtime guards keep callers away; this keeps paddle.js's loader, the CDN URL and the
    // Paddle API calls out of the binary in the first place. Mirror image of the Capacitor stub
    // table (capacitorStubs.test.ts), which does the same thing in the other direction.
    expect(moduleReplacements('mobile')).toContainEqual({
      from: '/^\\.\\/paddleCheckout$/', to: 'src/platform/stubs/paddleCheckout.ts',
    });
    expect(moduleReplacements('web').map((r) => r.to)).not.toContain('src/platform/stubs/paddleCheckout.ts');
  });

  it('the consent gate links somewhere the shell can actually open', async () => {
    // The pages are gone from the bundle, so a relative link would 404 — and even when they were
    // bundled, `window.open('capacitor://localhost/privacy.html')` silently did nothing on iOS:
    // Capacitor routes target=_blank to UIApplication.open, which drops a scheme nothing registers.
    // An absolute https URL is the only form that opens, and a reviewer does click these.
    const { legalUrl } = await import('../src/ui/dialogs/ConsentDialog');
    cap.platform = 'ios';
    expect(legalUrl('/privacy')).toBe('https://nivara.gamestao.com/privacy');
    expect(legalUrl('/terms')).toBe('https://nivara.gamestao.com/terms');
    // ...and the web build is unchanged: same-origin, next to the game, as it has always been.
    cap.platform = 'web';
    expect(legalUrl('/privacy')).toBe('/privacy.html');
    expect(legalUrl('/terms')).toBe('/terms.html');
  });
});

describe('the Paddle stub is a stand-in for the real module, not a smaller thing', () => {
  // The swap happens in webpack, so TypeScript only ever sees the real class: a method added to
  // PaddleCheckout and not to the stub compiles clean everywhere and throws "not a function" on
  // iOS only, at the moment a player taps buy. Same failure shape capacitorStubs.test.ts guards
  // for in the other direction, and the same reason it is a test rather than a convention.
  it('exposes every public method the real one does', async () => {
    const real = await import('../src/platform/web/paddleCheckout');
    const stub = await import('../src/platform/stubs/paddleCheckout');
    const methods = (c: new () => object) =>
      Object.getOwnPropertyNames(c.prototype).filter((n) => n !== 'constructor').sort();
    // Spelled out rather than compared as sets, because `load` is private and TypeScript's privacy is
    // erased at runtime — a comparison would need a filter, and a filter is where the next public
    // method quietly slips through. Growing either class fails this and forces the choice to be made.
    expect(methods(real.PaddleCheckout)).toEqual(['load', 'open']);
    expect(methods(stub.PaddleCheckout)).toEqual(['open']);
  });

  it('and refuses rather than half-working', async () => {
    const { PaddleCheckout } = await import('../src/platform/stubs/paddleCheckout');
    await expect(new PaddleCheckout().open()).rejects.toThrow(/native build/);
  });
});

// ── Cross-language: the StoreKit bridge and the receipt verifier must name the same products ────
describe('non-coin product ids agree between the iOS bridge and the server verifier', () => {
  // The shop buys four non-coin SKUs through the same window.NWBilling.purchase() the coin tiers
  // use, handing it the product key. The bridge derives the App Store product id from that key and
  // the server resolves the id back out of the receipt — two tables, in two languages, that no
  // compiler checks against each other. They disagreed until 2026-09-03 (the bridge derived
  // `<bundle>.coins.<key>` for all four), which fails *after* the player is charged.
  const EXPECTED: Record<string, string> = {
    monthly_card: 'sub.monthly',
    year_card: 'sub.year',
    starter_draw: 'starter.draw',
    starter_growth: 'starter.growth',
  };

  /** `"key": "value",` pairs out of a Swift dictionary literal / a TS record literal. */
  function pairs(src: string, from: string, closer: string): Record<string, string> {
    const start = src.indexOf(from);
    expect(start, `literal not found: ${from}`).toBeGreaterThan(-1);
    const body = src.slice(start + from.length);
    const block = body.slice(0, body.indexOf(closer));
    const out: Record<string, string> = {};
    for (const m of block.matchAll(/['"]([a-z_.]+)['"]\s*:\s*['"]([a-z_.]+)['"]/g)) out[m[1]!] = m[2]!;
    return out;
  }

  it('AppDelegate.swift maps each product key to the suffix the server expects', () => {
    const swift = fs.readFileSync(path.join(CLIENT_DIR, 'ios/App/App/AppDelegate.swift'), 'utf8');
    expect(pairs(swift, 'nonCoinProductSuffixes: [String: String] = [', ']')).toEqual(EXPECTED);
  });

  it('server/commercial resolveNonCoinProduct expects exactly those four suffixes', () => {
    const ts = fs.readFileSync(
      path.resolve(CLIENT_DIR, '../server/commercial/src/iap/productResolve.ts'), 'utf8');
    // The server's table is keyed the other way round (suffix → kind), so compare it inverted.
    const bySuffix = pairs(ts, 'suffixToKind: Record<string, IapProductKind> = {', '}');
    const byKey: Record<string, string> = {};
    for (const [suffix, kind] of Object.entries(bySuffix)) byKey[kind] = suffix;
    expect(byKey).toEqual(EXPECTED);
  });
});
