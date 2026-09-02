/**
 * wechatAssetUrlShape.test.ts — locks the WeChat build's two asset-URL modes (ASSET_PACKAGING §4.0).
 *
 * `NW_ASSET_CDN` picks between two modes that oblige OPPOSITE things of the pack manifest, and the
 * obligation lives in a different file (`wechatgame/project.private.config.json`) from the decision:
 *
 *   - unset  → `publicPath: ''`  → urls bake as `cdn/<hash><ext>`, read out of the PACKAGE by
 *              WechatAssetIO's non-remote branch. `packOptions.ignore` must therefore NOT exclude
 *              them. (Whole-package mode — currently the only mode that can run locally, the CDN
 *              being undeployed.)
 *   - set    → `publicPath: '<cdn>/'` → absolute urls, downloaded at runtime. `packOptions.ignore`
 *              MUST exclude `cdn/`, or ~21 MB of art goes into a 4 MB main package.
 *
 * Those two combinations were both self-consistent and the checkout shipped a third one — relative
 * urls plus an excluded `cdn/` — for as long as plan A existed, so the mode §4.0 calls "local IDE
 * self-test" never once ran (ASSET_PACKAGING_LOG.md §21). This file owns the *left* half of that
 * contract (what webpack bakes); `wechatPackageGate.test.ts` owns the right half (what the shipped
 * pack manifest does with it) and rule 4 of `checkWechatPackage.mjs` reconciles them on the real
 * artifact. Nothing here needs a build: what is guarded against is a human editing the config, and
 * reading the config is what catches that — same reasoning as wechatSingleBundle.test.ts.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { createRequire } from 'module';

// webpack.config.js sits outside every tsconfig `include`, so a plain `import` is an untyped-module
// error under `npm run typecheck`. Same createRequire trick as wechatSingleBundle.test.ts.
const requireJs = createRequire(path.join(__dirname, 'wechatAssetUrlShape.test.ts'));

interface AssetRule {
  test?: RegExp;
  type?: string;
  generator?: { filename?: string; publicPath?: string };
}
interface WebpackishConfig {
  module: { rules: AssetRule[] };
}
const makeConfig = requireJs('../webpack.config.js') as (
  env: { TARGET: string },
  argv: { mode: string },
) => WebpackishConfig;

/** Cleared around every config call for the same hermeticity reason as wechatSingleBundle.test.ts. */
const BAKED_ENVS = [
  'NW_API_BASE', 'NW_GATEWAY_WS', 'NW_WORLD_BASE', 'NW_SOCIAL_BASE', 'NW_AUCTION_BASE',
  'NW_ASSET_CDN', 'NW_BUILD_VERSION',
];

function loadConfig(target: string, env: Record<string, string> = {}): WebpackishConfig {
  const saved = BAKED_ENVS.map((k) => [k, process.env[k]] as const);
  for (const [k] of saved) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return makeConfig({ TARGET: target }, { mode: 'production' });
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
  }
}

/** The `asset/resource` rule — the one that decides every png/tao/mp3 url in the bundle. */
function assetRule(config: WebpackishConfig): AssetRule {
  const rules = config.module.rules.filter((r) => r?.type === 'asset/resource');
  expect(rules).toHaveLength(1); // two would make "the" url shape meaningless
  return rules[0]!;
}

describe('WeChat asset url shape', () => {
  it('bakes PACKAGE-RELATIVE urls when NW_ASSET_CDN is unset', () => {
    const { generator } = assetRule(loadConfig('wechat'));
    expect(generator?.filename).toBe('cdn/[contenthash][ext]');
    // '' (not undefined, not '/') is what makes the baked url a bare `cdn/<hash>` that
    // WechatAssetIO's `isRemote() === false` branch hands to readFileSync.
    expect(generator?.publicPath).toBe('');
  });

  it('bakes ABSOLUTE urls when NW_ASSET_CDN is set, with exactly one separator', () => {
    const { generator } = assetRule(loadConfig('wechat', { NW_ASSET_CDN: 'https://assets.example.com' }));
    expect(generator?.publicPath).toBe('https://assets.example.com/');
    expect(generator?.filename).toBe('cdn/[contenthash][ext]');
  });

  it('normalises a trailing slash instead of emitting `//cdn/`', () => {
    const { generator } = assetRule(loadConfig('wechat', { NW_ASSET_CDN: 'https://assets.example.com///' }));
    expect(generator?.publicPath).toBe('https://assets.example.com/');
  });

  it('applies to every wechat target, not just the main entry', () => {
    for (const target of ['wechat', 'wechat-e2e', 'wechat-probe']) {
      expect(assetRule(loadConfig(target)).generator?.filename, target).toBe('cdn/[contenthash][ext]');
    }
  });

  it('leaves the other targets alone — no cdn/ generator, so no pack manifest to agree with', () => {
    for (const target of ['web', 'crazygames', 'mobile']) {
      expect(assetRule(loadConfig(target)).generator, target).toBeUndefined();
    }
  });

  it('ignores NW_ASSET_CDN on the other targets (it is a WeChat-only knob)', () => {
    const rule = assetRule(loadConfig('web', { NW_ASSET_CDN: 'https://assets.example.com' }));
    expect(rule.generator).toBeUndefined();
  });
});
