/**
 * webPortalBuild.test.ts — the self-test web-portal targets `itch` and `newgrounds`
 * (design/game/WEB_PORTALS.md).
 *
 * Both are hosted on the portal's own domain like the CrazyGames build, so they must carry the same
 * off-origin guarantees (absolute backend addresses, no web payment surface), and each must report
 * its own name — a portal build that reports 'web' is a week of self-test data counted as nothing.
 *
 * Run with: npm test
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'path';
import { createRequire } from 'module';

const requireJs = createRequire(path.join(__dirname, 'webPortalBuild.test.ts'));
type Plugin = { constructor: { name: string }; [k: string]: unknown };
type ConfigFactory = (env: { TARGET: string }, argv: { mode: string }) => { entry: string; plugins: Plugin[] };
const configFactory = requireJs('../webpack.config.js') as ConfigFactory;

const BAKED_ENVS = [
  'NW_API_BASE', 'NW_GATEWAY_WS', 'NW_WORLD_BASE', 'NW_SOCIAL_BASE', 'NW_AUCTION_BASE',
  'NW_ASSET_CDN', 'NW_BUILD_VERSION',
];

function config(target: string, mode: string): ReturnType<ConfigFactory> {
  const saved = BAKED_ENVS.map((k) => [k, process.env[k]] as const);
  for (const [k] of saved) delete process.env[k];
  try {
    return configFactory({ TARGET: target }, { mode });
  } finally {
    for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
  }
}

function plugin(cfg: ReturnType<ConfigFactory>, name: string): Plugin | undefined {
  return cfg.plugins.find((p) => !!p && p.constructor?.name === name);
}

function defines(cfg: ReturnType<ConfigFactory>): Record<string, string> {
  const d = plugin(cfg, 'DefinePlugin') as unknown as { definitions: Record<string, string> };
  return Object.fromEntries(Object.entries(d.definitions).map(([k, v]) => [k, JSON.parse(v) as string]));
}

describe.each(['itch', 'newgrounds'])('the %s portal build', (target) => {
  it('shares the portal entry and template, but keeps its own TARGET', () => {
    const cfg = config(target, 'production');
    expect(cfg.entry).toBe('./src/entries/portal.ts');
    const html = plugin(cfg, 'HtmlWebpackPlugin') as unknown as { userOptions: { template: string; platform: string } };
    expect(html.userOptions.template).toBe('./public/portal/index.html');
    // The pre-bundle open tick's `p=` — the analytics channel name.
    expect(html.userOptions.platform).toBe(target);
    expect(defines(cfg)['globalThis.TARGET']).toBe(target);
  });

  it('bakes absolute backend addresses in production and keeps localhost in development', () => {
    const prod = defines(config(target, 'production'));
    for (const key of ['globalThis.__NW_API_BASE__', 'globalThis.__NW_GATEWAY_WS__', 'globalThis.__NW_WORLD_BASE__',
      'globalThis.__NW_SOCIAL_BASE__', 'globalThis.__NW_AUCTION_BASE__']) {
      expect(prod[key], key).toMatch(/^(https?|wss?):\/\//);
    }
    expect(defines(config(target, 'development'))['globalThis.__NW_API_BASE__']).toBe('http://localhost:18080');
  });

  it('ships no web payment surface', () => {
    const cfg = config(target, 'production');
    const copied = cfg.plugins
      .filter((p) => p.constructor?.name === 'CopyPlugin')
      .flatMap((p) => (p.patterns as { from: string }[]).map((pat) => pat.from));
    expect(copied.some((f) => f.endsWith('pay.html'))).toBe(false);
    const swapped = cfg.plugins
      .filter((p) => p.constructor?.name === 'NormalModuleReplacementPlugin' && typeof p.newResource === 'string')
      .map((p) => (p.newResource as string).replace(/\\/g, '/'));
    expect(swapped.some((r) => r.endsWith('src/platform/stubs/paddleCheckout.ts'))).toBe(true);
  });
});

describe('clientPlatformName() / isPortalBuild()', () => {
  const g = globalThis as { TARGET?: string };
  afterEach(() => { delete g.TARGET; vi.resetModules(); });

  it.each([
    ['itch', 'itch', true], ['newgrounds', 'newgrounds', true], ['crazygames', 'crazygames', true],
    ['wechat', 'wechat', false], ['web', 'web', false], ['mobile', 'web', false], ['bogus', 'web', false],
  ])('TARGET=%s reports %s (portal: %s)', async (target, name, portal) => {
    g.TARGET = target;
    const { clientPlatformName, isPortalBuild } = await import('../src/platform/clientPlatform');
    expect(clientPlatformName()).toBe(name);
    expect(isPortalBuild()).toBe(portal);
  });
});

describe('PortalPlatform', () => {
  it('is a guest-only, notice-only, free-stamina build with no shop', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    vi.stubGlobal('document', { getElementById: () => ({}) });
    try {
      const { PortalPlatform } = await import('../src/platform/portal/PortalPlatform');
      const p = new PortalPlatform('game-canvas');
      expect(p.silentAccountOnly).toBe(true);
      expect(p.entryNoticeOnly).toBe(true);
      expect(p.freePveStamina).toBe(true);
      expect(p.iapKind()).toBeNull();
      expect(p.hasRewardedAd()).toBe(false);
      expect(p.supportedLocales[0]).toBe('en');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
