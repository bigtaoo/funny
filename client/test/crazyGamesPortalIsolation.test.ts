/**
 * crazyGamesPortalIsolation.test.ts — what the CrazyGames build must be, given that the portal
 * hosts it on *its own* domain and reviews it against its own rules.
 *
 * The `crazygames` target had existed for months as "the web build plus an ad SDK", and every one
 * of the four things below was wrong in the same silent way the iOS build's were (see
 * nativePaymentIsolation.test.ts, whose shape this file follows — same config-reading helpers,
 * same "assert the answer, not the absence of a throw"):
 *
 *   1. A production build baked NO backend address. `isProd` alone meant "" = same-origin, which on
 *      the portal is crazygames.com — so net/config.ts returned null and the uploaded game was
 *      silently offline-only: no login, no cloud save, no PvP, no SLG, nothing to review.
 *   2. `legalUrl()` returned the root-relative `/privacy.html`, which under the portal's domain is
 *      a 404. A reachable privacy policy is both a portal requirement and a GDPR one.
 *   3. The build copied the web payment surface (pay.html loads paddle.js and opens a live
 *      checkout, pricing/refunds/home advertise and refund it) into the very bundle handed to the
 *      portal, and compiled the Paddle checkout module in alongside it.
 *   4. Ads played over the game's own BGM: `requestAd` was called without an `adStarted` callback,
 *      so nothing muted. Portal QA checks precisely this.
 *
 * Run with: npm test
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { createRequire } from 'module';
import type { AudioBus, AudioCue, MusicTrack } from '../src/audio/types';

// ── Build config: read the real webpack.config.js ───────────────────────────────────────────────
// Same createRequire trick as nativePaymentIsolation.test.ts / wechatSingleBundle.test.ts:
// webpack.config.js sits outside every tsconfig `include`, so a plain import is an untyped module.
const CLIENT_DIR = path.resolve(__dirname, '..');
const requireJs = createRequire(path.join(__dirname, 'crazyGamesPortalIsolation.test.ts'));
type ConfigFactory = (env: { TARGET: string }, argv: { mode: string }) => { plugins: unknown[] };
const configFactory = requireJs('../webpack.config.js') as ConfigFactory;

/**
 * Baked-URL env vars, cleared around every config call so this file is hermetic: a shell that
 * happens to export NW_WORLD_BASE (a deploy session, CI) would otherwise change the answers, and
 * with NW_SOCIAL_BASE unset it would trip the derived-port guard and throw.
 */
const BAKED_ENVS = [
  'NW_API_BASE', 'NW_GATEWAY_WS', 'NW_WORLD_BASE', 'NW_SOCIAL_BASE', 'NW_AUCTION_BASE',
  'NW_ASSET_CDN', 'NW_BUILD_VERSION',
];

function withCleanEnv<T>(fn: () => T, overrides: Record<string, string> = {}): T {
  const saved = BAKED_ENVS.map((k) => [k, process.env[k]] as const);
  for (const [k] of saved) delete process.env[k];
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(overrides)) delete process.env[k];
    for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
  }
}

/** The `globalThis.__NW_*__` values a target/mode bakes in, as net/config.ts will read them. */
function bakedGlobals(target: string, mode: string, env: Record<string, string> = {}): Record<string, string> {
  return withCleanEnv(() => {
    const { plugins } = configFactory({ TARGET: target }, { mode });
    const define = plugins.find(
      (p): p is { constructor: { name: string }; definitions: Record<string, string> } =>
        !!p && (p as { constructor?: { name?: string } }).constructor?.name === 'DefinePlugin',
    );
    if (!define) throw new Error('no DefinePlugin in the config — the URL baking moved');
    // DefinePlugin holds JSON.stringify'd source text; parse it back into the runtime value.
    return Object.fromEntries(
      Object.entries(define.definitions).map(([k, v]) => [k, JSON.parse(v) as string]),
    );
  }, env);
}

/** Every file the target's CopyPlugins copy into dist, client-relative with forward slashes. */
function copiedFiles(target: string, mode = 'development'): string[] {
  return withCleanEnv(() => {
    const { plugins } = configFactory({ TARGET: target }, { mode });
    return plugins
      .filter((p): p is { constructor: { name: string }; patterns: { from: string }[] } =>
        !!p && (p as { constructor?: { name?: string } }).constructor?.name === 'CopyPlugin')
      .flatMap((p) => p.patterns.map((pat) => pat.from.replace(/\\/g, '/')));
  });
}

/** The modules the target swaps out, as client-relative `to` paths. */
function moduleReplacementTargets(target: string, mode = 'development'): string[] {
  return withCleanEnv(() => {
    const { plugins } = configFactory({ TARGET: target }, { mode });
    return plugins
      .filter((p): p is { constructor: { name: string }; newResource: unknown } =>
        !!p && (p as { constructor?: { name?: string } }).constructor?.name === 'NormalModuleReplacementPlugin')
      .filter((p) => typeof p.newResource === 'string')  // the `.hires` art swap rewrites from a callback
      .map((p) => path.relative(CLIENT_DIR, p.newResource as string).replace(/\\/g, '/'));
  });
}

// ── 1. The uploaded bundle can reach our backend ────────────────────────────────────────────────

describe('the CrazyGames production build bakes absolute backend addresses', () => {
  const SERVICES = [
    'globalThis.__NW_API_BASE__',
    'globalThis.__NW_GATEWAY_WS__',
    'globalThis.__NW_WORLD_BASE__',
    'globalThis.__NW_SOCIAL_BASE__',
    'globalThis.__NW_AUCTION_BASE__',
  ];

  it('REGRESSION: every service address is absolute, not "" (= the portal\'s own origin)', () => {
    const baked = bakedGlobals('crazygames', 'production');
    for (const key of SERVICES) {
      expect(baked[key], `${key} must be baked for the portal build`).toMatch(/^(https?|wss?):\/\//);
    }
  });

  it('the mobile build is unchanged — it had this fixed first, for the same reason', () => {
    const baked = bakedGlobals('mobile', 'production');
    for (const key of SERVICES) expect(baked[key]).toMatch(/^(https?|wss?):\/\//);
  });

  it('the web build still uses same-origin relative bases (Caddy path-routes one origin)', () => {
    // The contrast that makes the fix a fix: on our own domain "" is correct and must stay,
    // which is why this could not be solved by baking addresses for everyone.
    const baked = bakedGlobals('web', 'production');
    expect(baked['globalThis.__NW_API_BASE__']).toBe('');
    expect(baked['globalThis.__NW_WORLD_BASE__']).toBe('');
  });

  it('`start:crazygames` (dev mode) keeps the localhost stack, exactly like `start:web`', () => {
    const baked = bakedGlobals('crazygames', 'development');
    expect(baked['globalThis.__NW_API_BASE__']).toBe('http://localhost:18080');
    expect(baked['globalThis.__NW_GATEWAY_WS__']).toBe('ws://localhost:8086/gw');
    expect(baked['globalThis.__NW_WORLD_BASE__']).toBe('http://localhost:18084');
  });

  it('environment variables still win, so a staging portal build is one env away', () => {
    const baked = bakedGlobals('crazygames', 'production', { NW_API_BASE: 'https://staging.example/api' });
    expect(baked['globalThis.__NW_API_BASE__']).toBe('https://staging.example/api');
  });

  it('the derived-port deploy guard does not fire on this target', () => {
    // That guard (2026-08-02) exists for builds that bake NW_WORLD_BASE to a real domain while
    // leaving NW_SOCIAL_BASE/NW_AUCTION_BASE to be *derived* with a dev-only port. This target
    // bakes all three itself, so it must not throw for want of env vars nobody needs to set.
    expect(() => bakedGlobals('crazygames', 'production')).not.toThrow();
  });
});

// ── 2 & 3. What travels with the package ────────────────────────────────────────────────────────

describe('the CrazyGames bundle carries no web payment surface', () => {
  const WEB_COMMERCE_PAGES = ['pay.html', 'pricing.html', 'refunds.html', 'home.html', 'terms.html', 'privacy.html'];

  it('REGRESSION: copies none of the web pages into the uploaded package', () => {
    const copied = copiedFiles('crazygames');
    for (const page of WEB_COMMERCE_PAGES) {
      expect(copied.some((f) => f.endsWith(`/${page}`)), `crazygames bundle must not ship ${page}`).toBe(false);
    }
  });

  it('REGRESSION: swaps the Paddle checkout module for the throwing stub, as the mobile build does', () => {
    // CrazyGamesPlatform.iapKind() already returns null so no caller reaches it — but "unreachable"
    // is a property of today's call sites, not of the build (the lesson of the stray wechat chunk).
    expect(moduleReplacementTargets('crazygames')).toContain('src/platform/stubs/paddleCheckout.ts');
    expect(moduleReplacementTargets('web')).not.toContain('src/platform/stubs/paddleCheckout.ts');
  });

  it('REGRESSION: both exclusions hold in either mode, unlike the address baking', () => {
    // The config has two predicates one condition apart: `isOffOrigin` (a property of the target)
    // gates these two exclusions, `bakesRemoteBases` adds "and production" and gates the addresses,
    // because `start:crazygames` must keep the localhost stack. Collapsing them — the obvious
    // tidy-up — would put a live Paddle checkout back into a bundle built in development mode,
    // which is a thing someone in a hurry uploads.
    for (const mode of ['development', 'production']) {
      expect(copiedFiles('crazygames', mode).some((f) => f.endsWith('/pay.html')), `mode=${mode}`).toBe(false);
      expect(moduleReplacementTargets('crazygames', mode), `mode=${mode}`)
        .toContain('src/platform/stubs/paddleCheckout.ts');
    }
  });

  it('branding icons stay — they are referenced by the HTML template, not commerce', () => {
    expect(copiedFiles('crazygames')).toContain('public/site.webmanifest');
    expect(copiedFiles('crazygames')).toContain('public/apple-touch-icon.png');
  });

  it('the web build still ships all of them (this is their home, and Paddle crawls them)', () => {
    const copied = copiedFiles('web');
    for (const page of WEB_COMMERCE_PAGES) {
      expect(copied.some((f) => f.endsWith(`/${page}`)), `web bundle must ship ${page}`).toBe(true);
    }
  });
});

describe('legalUrl() — the consent gate links somewhere that exists', () => {
  type Globals = { TARGET?: string };
  const g = globalThis as Globals;
  afterEach(() => { delete g.TARGET; vi.resetModules(); });

  // Both cases re-import ConsentDialog after resetModules, which drags PIXI, sketchUi and the
  // locale tables in with it — normally ~0.5s, but measured at 5s on a loaded machine, i.e. right
  // on vitest's default. The generous timeout is about the import, not about the assertions.
  const IMPORT_BUDGET_MS = 30_000;

  it('REGRESSION: on CrazyGames the links are absolute https, not a portal-domain 404', async () => {
    g.TARGET = 'crazygames';
    const { legalUrl } = await import('../src/ui/dialogs/ConsentDialog');
    expect(legalUrl('/privacy')).toBe('https://nivara.gamestao.com/privacy');
    expect(legalUrl('/terms')).toBe('https://nivara.gamestao.com/terms');
  }, IMPORT_BUDGET_MS);

  it('the plain web build is unchanged: same-origin, next to the game', async () => {
    g.TARGET = 'web';
    const { legalUrl } = await import('../src/ui/dialogs/ConsentDialog');
    expect(legalUrl('/privacy')).toBe('/privacy.html');
  }, IMPORT_BUDGET_MS);
});

// ── 4. Silence while an ad plays ────────────────────────────────────────────────────────────────

/** Records the gains audioSettings pushes, which is the only observable effect of suspension. */
class RecordingBus implements AudioBus {
  sfx: number[] = [];
  music: number[] = [];
  async preload(): Promise<void> {}
  play(_cue: AudioCue, _count?: number): void {}
  setSfxVolume(v: number): void { this.sfx.push(v); }
  setMusicVolume(v: number): void { this.music.push(v); }
  updateMusic(_desired: MusicTrack | null, _dtMs: number): void {}
  resume(): void {}
}

function stubMinimalDom(): void {
  const fakeCanvas = { id: '', style: {} } as unknown as HTMLCanvasElement;
  vi.stubGlobal('document', {
    getElementById: () => null,
    createElement: () => fakeCanvas,
    body: { appendChild: () => {}, style: {} },
  });
  vi.stubGlobal('window', { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720 });
  vi.stubGlobal('localStorage', new Map<string, string>());
  vi.stubGlobal('navigator', { language: 'en' });
}

describe('CrazyGamesPlatform ads mute the game while they play', () => {
  /** Everything a case needs, all from ONE module registry (vi.resetModules invalidates it). */
  async function setup() {
    const audio = await import('../src/audio/audioSettings');
    const { setAudioBus } = await import('../src/audio/audioBus');
    const { CrazyGamesPlatform } = await import('../src/platform/crazygames/CrazyGamesPlatform');
    const bus = new RecordingBus();
    setAudioBus(bus);
    const writes: string[] = [];
    audio.installAudioSettings({
      storage: {
        getItem: () => null,
        setItem: (_k: string, v: string) => { writes.push(v); },
        removeItem: () => {},
      },
    });
    bus.sfx.length = 0;
    bus.music.length = 0;
    const platform = new CrazyGamesPlatform();
    /** Callbacks the platform hands the SDK, captured so a case can fire them one at a time. */
    let cb: { adStarted?(): void; adFinished?(): void; adError?(e: unknown): void } = {};
    (platform as unknown as { sdk: unknown }).sdk = {
      ad: { requestAd: (_type: string, c: typeof cb) => { cb = c; } },
    };
    return { platform, bus, writes, audio, cbs: () => cb };
  }

  const silent = (bus: RecordingBus): boolean =>
    bus.sfx[bus.sfx.length - 1] === 0 && bus.music[bus.music.length - 1] === 0;

  beforeEach(() => {
    vi.resetModules();
    stubMinimalDom();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    const { resetAudioSettingsForTest } = await import('../src/audio/audioSettings');
    resetAudioSettingsForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('REGRESSION: a midgame ad silences both channels on adStarted and restores them after', async () => {
    const { platform, bus, cbs } = await setup();
    const p = platform.showMidgameAd();
    cbs().adStarted?.();
    expect(silent(bus)).toBe(true);
    cbs().adFinished?.();
    await p;
    expect(silent(bus)).toBe(false);
  });

  it('a rewarded ad does the same, and still returns its token', async () => {
    const { platform, bus, cbs } = await setup();
    const p = platform.showRewardedAd('acct-1');
    cbs().adStarted?.();
    expect(silent(bus)).toBe(true);
    cbs().adFinished?.();
    await expect(p).resolves.toMatchObject({ platform: 'dev' });
    expect(silent(bus)).toBe(false);
  });

  it('an ad that errors after starting still restores the audio', async () => {
    const { platform, bus, cbs } = await setup();
    const p = platform.showRewardedAd('acct-1');
    cbs().adStarted?.();
    cbs().adError?.(new Error('no fill'));
    await expect(p).resolves.toBeNull();
    expect(silent(bus)).toBe(false);
  });

  it('REGRESSION: an SDK that starts an ad and never calls back does not mute the session forever', async () => {
    // The midgame timeout predates the mute; with it, that timeout is what keeps a stuck SDK from
    // costing the player their audio for the rest of the session rather than just one result screen.
    const { platform, bus, cbs } = await setup();
    const p = platform.showMidgameAd();
    cbs().adStarted?.();
    expect(silent(bus)).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    await p;
    expect(silent(bus)).toBe(false);
  });

  it('REGRESSION: the rewarded ad has the same escape hatch (it had none)', async () => {
    const { platform, bus, cbs } = await setup();
    const p = platform.showRewardedAd('acct-1');
    cbs().adStarted?.();
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(p).resolves.toBeNull();
    expect(silent(bus)).toBe(false);
  });

  it('suspension never persists, and never overwrites the player\'s own mute', async () => {
    // Two failure modes a plain setAudioMuted(true) would have: a crashed ad leaving `nw_audio.muted`
    // on disk, and un-muting a player who had muted the game themselves before the ad.
    const { bus, writes, audio } = await setup();
    audio.setAudioMuted(true);
    writes.length = 0;
    audio.setAudioSuspended(true);
    expect(silent(bus)).toBe(true);
    audio.setAudioSuspended(false);
    expect(writes, 'suspension must not touch storage').toEqual([]);
    expect(audio.getAudioSettings().muted, 'the player\'s own mute survives the ad').toBe(true);
    expect(silent(bus)).toBe(true);
  });

  it('restores the exact gains the player had, not merely "something audible"', async () => {
    // `silent()` only distinguishes 0 from not-0, so on its own it would accept an ad that came
    // back at full blast. The gains are a matrix (master x channel, audioSettings' apply()), and
    // the restore path recomputes rather than remembering — which is right, and worth pinning to
    // the arithmetic rather than to "the sound came back".
    const { bus, audio } = await setup();
    audio.setAudioVolume('master', 0.5);
    audio.setAudioVolume('sfx', 0.4);
    audio.setAudioVolume('bgm', 0.2);
    audio.setAudioSuspended(true);
    audio.setAudioSuspended(false);
    expect(bus.sfx[bus.sfx.length - 1]).toBeCloseTo(0.5 * 0.4, 5);
    expect(bus.music[bus.music.length - 1]).toBeCloseTo(0.5 * 0.2, 5);
  });

  it('a slider dragged mid-ad stays silent, and lands at its new value afterwards', async () => {
    // The settings screen is reachable while an ad plays on a portal that renders it beside the
    // canvas, and every write goes through the same apply() — which must keep reading `suspended`
    // rather than treating "the player just set a volume" as an unsuspend.
    const { bus, audio } = await setup();
    audio.setAudioSuspended(true);
    audio.setAudioVolume('sfx', 0.9);
    expect(silent(bus), 'a volume write must not un-silence an ad').toBe(true);
    audio.setAudioSuspended(false);
    expect(bus.sfx[bus.sfx.length - 1]).toBeCloseTo(0.9, 5);
  });

  it('is idempotent, so a double adStarted or a raced timeout is harmless', async () => {
    // Both callbacks and the timeout call into this, and the SDK is not ours: two adStarted events,
    // or an adFinished arriving after the timeout already unsuspended, must not leave a counter
    // half-decremented and the game silent.
    const { bus, audio } = await setup();
    audio.setAudioSuspended(true);
    audio.setAudioSuspended(true);
    audio.setAudioSuspended(false);
    expect(silent(bus)).toBe(false);
    audio.setAudioSuspended(false);
    expect(silent(bus)).toBe(false);
  });
});

describe('CrazyGamesPlatform opens and closes the portal loading window as a pair', () => {
  beforeEach(() => { vi.resetModules(); stubMinimalDom(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('REGRESSION: calls sdkGameLoadingStart while still loading, not only Stop at the end', async () => {
    const calls: string[] = [];
    const sdk = {
      init: () => { calls.push('init'); return Promise.resolve(); },
      game: {
        gameplayStart: () => {}, gameplayStop: () => {},
        sdkGameLoadingStart: () => calls.push('start'),
        sdkGameLoadingStop: () => calls.push('stop'),
      },
      ad: { requestAd: () => {} },
    };
    vi.stubGlobal('window', { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, CrazyGames: { SDK: sdk } });

    const { CrazyGamesPlatform } = await import('../src/platform/crazygames/CrazyGamesPlatform');
    const platform = new CrazyGamesPlatform();
    await platform.onLoadingComplete();
    expect(calls).toEqual(['init', 'start', 'stop']);
  });

  it('a host without the SDK (our own dev server) is a no-op, not a throw', async () => {
    const { CrazyGamesPlatform } = await import('../src/platform/crazygames/CrazyGamesPlatform');
    await expect(new CrazyGamesPlatform().onLoadingComplete()).resolves.toBeUndefined();
  });
});
