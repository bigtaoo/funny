/**
 * wechatSingleBundle.test.ts — guards the WeChat build's "exactly one JS file" contract
 * (ASSET_PACKAGING §4.0).
 *
 * The WeChat runtime has no dynamic-import/chunk-loading support, the shell `game.js` only
 * `require()`s `pixigame.js`, and `project.private.config.json` packs only that file. So a split
 * point in the wechat graph fails twice over: the extra `<id>.pixigame.js` is never loaded, AND
 * webpack drags its JSONP chunk-loading runtime (`document.createElement('script')` /
 * `importScripts`) into the main bundle — neither exists in WeChat, so the first chunk request
 * throws rather than degrading. `output.asyncChunks: false` is what makes the contract a build
 * constraint instead of a comment.
 *
 * Why this is a config test and not a build test: a real `build:wechat` is ~20s and emits ~23 MiB
 * of CDN assets, far too heavy for the default suite — and it would only ever re-confirm what the
 * config already determines. The failure this guards against is a human deleting the option (or
 * "unifying" it across targets), which is exactly what reading the config catches.
 *
 * Found the hard way (2026-08-17): `@capacitor/local-notifications` registers its web
 * implementation as `web: () => import('./web')` — Capacitor's standard lazy pattern — and
 * `src/platform/localReminders.ts` imports it on every target, so a stray `90.pixigame.js` had
 * been shipping unnoticed. It happened to be unreachable at runtime, but that was a property of
 * the call sites, not of the build.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const CLIENT_DIR = path.resolve(__dirname, '..');

// webpack.config.js sits outside every tsconfig `include`, so a plain `import` is an untyped-module
// error under `npm run typecheck`. Same createRequire trick as preloadBootAssetsPlugin.test.ts.
const requireJs = createRequire(path.join(__dirname, 'wechatSingleBundle.test.ts'));

interface WebpackishConfig {
  entry: unknown;
  output: { filename?: string; iife?: boolean; globalObject?: string; asyncChunks?: boolean };
  optimization?: { splitChunks?: unknown };
}
const makeConfig = requireJs('../webpack.config.js') as (
  env: { TARGET: string },
  argv: { mode: string },
) => WebpackishConfig;

/**
 * Build-time-baked backend URLs. Cleared around every config call so the test is hermetic: with
 * NW_WORLD_BASE set but NW_SOCIAL_BASE/NW_AUCTION_BASE unset, the config *deliberately* throws
 * (the 2026-08-02 derived-port deploy guard). That guard is correct, but it must not be able to
 * turn this test red just because the shell or CI job happens to export a deploy variable.
 */
const BAKED_ENVS = [
  'NW_API_BASE', 'NW_GATEWAY_WS', 'NW_WORLD_BASE', 'NW_SOCIAL_BASE', 'NW_AUCTION_BASE',
  'NW_ASSET_CDN', 'NW_BUILD_VERSION',
];

function loadConfig(target: string, mode = 'production'): WebpackishConfig {
  const saved = BAKED_ENVS.map((k) => [k, process.env[k]] as const);
  for (const [k] of saved) delete process.env[k];
  try {
    return makeConfig({ TARGET: target }, { mode });
  } finally {
    for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
  }
}

/**
 * Does the repo's ignore ruleset cover this path? Asks git itself rather than matching pattern
 * text, so the assertion is about real behaviour and survives any rewrite of the glob.
 *
 * `--no-index` matters: without it git skips the rules for already-tracked paths, which is exactly
 * the half of this suite that checks `game.js` and friends are NOT swallowed.
 */
function isIgnored(repoRelPath: string): boolean {
  try {
    const res = execFileSync('git', ['check-ignore', '--no-index', repoRelPath], {
      cwd: path.resolve(CLIENT_DIR, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return res.trim().length > 0;
  } catch (e) {
    // check-ignore exits 1 for "no path is ignored" — a normal answer, which execFileSync throws
    // on regardless. Anything else (2 = bad usage, ENOENT = no git) is a real failure worth raising.
    const status = (e as { status?: number }).status;
    if (status === 1) return false;
    throw e;
  }
}

describe('wechat build emits a single JS file', () => {
  it('disables async chunks, so any reachable import() is inlined', () => {
    expect(loadConfig('wechat').output.asyncChunks).toBe(false);
  });

  it('still declares the single-IIFE output the shell game.js requires', () => {
    const { output } = loadConfig('wechat');
    // Asserted alongside asyncChunks because these four together ARE the contract: one
    // self-executing file, named pixigame.js, addressing globalThis.
    expect(output.filename).toBe('pixigame.js');
    expect(output.iife).toBe(true);
    expect(output.globalObject).toBe('globalThis');
  });

  it('has one entry and no manual chunk splitting — the other two ways extra files appear', () => {
    const cfg = loadConfig('wechat');
    // A multi-entry object or a splitChunks cacheGroup would each emit a second file even with
    // asyncChunks:false, so neither is a safe thing to add on this branch.
    expect(typeof cfg.entry).toBe('string');
    expect(cfg.optimization?.splitChunks).toBeUndefined();
  });

  // Not a redundant restatement of the above: it guards against "fixing" the stray chunk globally.
  // Web/CrazyGames/mobile all run in real browsers where chunks load fine, land in gitignored
  // dist/, and are a genuine win — code splitting must stay ON there.
  it.each(['web', 'crazygames', 'mobile'])('keeps code splitting enabled for %s', (target) => {
    expect(loadConfig(target).output.asyncChunks).not.toBe(false);
  });
});

describe('wechat build artifacts are gitignored', () => {
  // The pattern is a glob (`wechatgame/*pixigame.js*`) precisely so an unforeseen chunk shows up as
  // a build artifact rather than untracked noise — the state that hid `90.pixigame.js` for so long.
  it.each([
    'client/wechatgame/pixigame.js',
    'client/wechatgame/pixigame.js.map',
    'client/wechatgame/pixigame.js.LICENSE.txt',
    'client/wechatgame/90.pixigame.js',
    'client/wechatgame/90.pixigame.js.map',
  ])('ignores %s', (p) => {
    expect(isIgnored(p)).toBe(true);
  });

  // The flip side of widening the glob: the shell files live in the SAME directory and are tracked.
  // A pattern loose enough to swallow one of these would break the mini-game package silently.
  it.each([
    'client/wechatgame/game.js',
    'client/wechatgame/game.json',
    'client/wechatgame/project.private.config.json',
  ])('does not ignore the tracked shell file %s', (p) => {
    expect(isIgnored(p)).toBe(false);
  });
});
