// ⚠️ These two lines are load-bearing, in this order (ASSET_PACKAGING §4.3) — same rule as
// `entries/wechat.ts`: `installHost` must be the FIRST import (PIXI evaluates DOM sniffing at
// module top level, so any host install written inside a function body is already too late), and
// `@pixi/unsafe-eval` right behind it (this runtime bans `eval`/`new Function`).
import '../platform/wechat/installHost';
import '@pixi/unsafe-eval';

/**
 * wechat-layout.ts — the geometry sweep, run from INSIDE a mini-game package
 * (`npm run build:wechat-layout`, **never shipped**).
 *
 * ── Why an entry, and not automation ────────────────────────────────────────────────────────────
 * `test/browser/portraitLayout.spec.ts` walks 36 stops on ten viewports and judges the real display
 * tree, and every number in it was measured on Chromium. The whole reason to repeat it here is that
 * the two runtimes disagree about the one input the judgement rests on: every text style in this
 * repo asks for `fontFamily: 'monospace'`, `fitFont` divides once to find "the size that fits" on
 * the assumption that a monospace advance scales linearly with the size, and the legibility floor is
 * an assertion about how big a glyph ends up on screen. The mini-game runtime has no DOM, its canvas
 * comes from `wx.createCanvas()`, and 'monospace' is resolved by the phone — many Android devices
 * have no monospaced CJK face at all. `render/textMetricsProbe.ts` (run by `wechat-probe.ts`)
 * measures that divergence; this entry measures what it DOES to the layout.
 *
 * It cannot be done from outside. `miniprogram-automator` connects to the IDE's socket and then
 * hangs on every `evaluate` / `callWxMethod`, because a mini-*game* has no appservice for those
 * commands to reach (measured 2026-08-31; `claudedocs/client-testing.md` and UI_DESIGN_LOG §50.6
 * both record it as a dead end — do not try it a third time). So the package walks itself, exactly
 * like the two probe entries that came before it (`wechat-e2e.ts`, `wechat-probe.ts`), and the
 * report leaves through `wx.env.USER_DATA_PATH` — in the DevTools simulator a real directory on
 * this machine, readable straight off disk.
 *
 * ── What it shares with the browser sweep, and what it cannot ───────────────────────────────────
 * Shared, by import rather than by restatement: the stop table (`testing/layoutStops.ts`), the
 * auditor (`testing/layoutAudit.ts`), the `__nwE2E` handle (`testing/instrumentViews.ts`) and the
 * walk (`testing/layoutWalk.ts`). Not shared, and this is the honest gap:
 *
 *  · **No seed.** The browser sweep writes a maxed-out account straight into the stack's Mongo
 *    through `docker exec` (test/browser/lib/seed.ts) — an empty leaderboard cannot break a layout,
 *    which is what made its first two rounds nearly worthless (§50.1). Nothing inside a mini-game
 *    package can reach a database. This sweep therefore walks a FRESH account, and the stops whose
 *    content the seed supplies will report thin. Read it as "does the WeChat runtime lay out what
 *    it does paint differently", not as a replacement for the browser matrix.
 *  · **One shape.** The browser sweep's power is ten viewports; a simulator run is whatever device
 *    the IDE is set to. Change it in DevTools and run again.
 *  · **One locale.** `WechatPlatform.supportedLocales` is `['zh']`. Chinese is the interesting one
 *    here anyway — full-width glyphs and no spaces for word-wrap to break at.
 */
import { startApp } from '../app';
import { WechatPlatform } from '../platform/wechat/WechatPlatform';
import { setAssetIO } from '../assets/assetIO';
import { setNetTransport } from '../net/transport';
import { WechatAssetIO } from '../assets/WechatAssetIO';
import { setAudioBus } from '../audio/audioBus';
import { installWechatPixiAdapter } from '../platform/wechat/wechatPixiAdapter';
import { WechatAudioBus } from '../platform/wechat/WechatAudioBus';
import { WechatTransport } from '../platform/wechat/wechatTransport';
import { instrumentViews, type E2EHandle } from '../testing/instrumentViews';
import { walkLayout } from '../testing/layoutWalk';
import { zh } from '../i18n/locales/zh';
import type { TranslationKey } from '../i18n';
import type { AuthCredential } from '../platform/IPlatform';

declare const wx: {
  env: { USER_DATA_PATH: string };
  setEnableDebug(opts: { enableDebug: boolean }): void;
  getSystemInfoSync(): Record<string, unknown>;
  getFileSystemManager(): {
    writeFileSync(p: string, data: string, enc: 'utf8' | 'base64'): void;
    copyFileSync(from: string, to: string): void;
    mkdirSync(p: string, recursive?: boolean): void;
  };
};

// Real-device "预览" ships with no attached console, and DevTools' remote-debug bridge cannot load
// a WeChat bundle containing ES2020 syntax (ASSET_PACKAGING_LOG §20.2) — so the `console.log` lines
// below are otherwise unreachable on a phone. Unconditional here, and safe only because this entry
// is `build:wechat-layout`, never shipped (see header).
try { wx.setEnableDebug({ enableDebug: true }); } catch { /* older base library: no-op */ }

const OUT_DIR = `${wx.env.USER_DATA_PATH}/nw-layout`;
const OUT_FILE = `${OUT_DIR}/report.json`;
const TAG = '[nw-layout]';

const log = (line: string): void => { console.log(`${TAG} ${line}`); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** One presented frame. `requestAnimationFrame` is provided by the mini-game runtime itself. */
const frame = (): Promise<void> => new Promise((r) => { requestAnimationFrame(() => r()); });

log('entry loaded');

installWechatPixiAdapter();
setAssetIO(new WechatAssetIO());
setNetTransport(new WechatTransport());
setAudioBus(new WechatAudioBus());

/**
 * The shipped platform, with one method replaced.
 *
 * `WechatPlatform.getAuthCredential()` returns a `wx.login` code, and `app/nav/auth.ts`'s
 * `resolveEntry()` treats `kind: 'wx'` as "already identified" and goes straight to the lobby —
 * there is no LoginScene on this platform at all. That is correct for players and useless here: the
 * sweep needs a fresh, empty, KNOWN account on the local stack, and the only door to one is
 * `loginCb.onRegister`, the same door the browser sweep uses. Handing back a device credential
 * opens it, and costs nothing else: `/auth/device` and `/auth/register` are the same endpoints the
 * web build talks to, and every layer above auth is untouched.
 *
 * (The bundle still has to be built with the stack's addresses baked in — see the header of
 * `npm run build:wechat-layout` in package.json — and DevTools' 「不校验合法域名」 has to be on,
 * since `http://localhost:8088` is not a configured request domain.)
 */
class LayoutProbePlatform extends WechatPlatform {
  override getAuthCredential(): Promise<AuthCredential> {
    return Promise.resolve({ kind: 'device', deviceId: `wxlayout-${Date.now()}` });
  }
}

/** The literal, parameter-free prefix of a UI string — what a tap hop can match on. */
function label(key: TranslationKey): string {
  const raw = (zh as Record<string, string>)[key] ?? key;
  return raw.split('{')[0]!.trim();
}

const fs = wx.getFileSystemManager();

/**
 * Best-effort PNG per stop. **This is the half that matters most and the half most likely to be
 * missing**, so it says which it was rather than failing quietly: the browser sweep's last three
 * real defects were all found by reading PNGs of stops the gate had just called clean (§50.11), and
 * a green report with no pictures is exactly the state that lesson warns about.
 *
 * Two paths, in the order measured 2026-09-12 — see each one's own note below for why it is where
 * it is. Whichever fails does so into `shotErrors`, which ends up in the report.
 */
const shotErrors: string[] = [];
async function capture(name: string): Promise<void> {
  const handle = (globalThis as unknown as { __nwE2E?: E2EHandle }).__nwE2E;
  const app = handle?.app;
  if (!app) return;
  const dest = `${OUT_DIR}/${name}.png`;
  // Path A — the runtime's own screenshot API, on the SCREEN canvas. Preferred because it is the
  // one that does not go through PixiJS's DOM assumptions at all.
  //
  // The `render()` on the line before is load-bearing, not tidiness: PIXI builds its WebGL context
  // with `preserveDrawingBuffer: false`, so the colour buffer is only guaranteed valid until the
  // end of the task that drew it. Rendering and reading back in the same synchronous block is what
  // makes this a picture of the current screen rather than an empty one.
  try {
    const canvas = app.view as unknown as { toTempFilePathSync?(o: Record<string, unknown>): string };
    if (typeof canvas.toTempFilePathSync === 'function') {
      // Render BETWEEN two presented frames, rather than snapshotting straight after a render.
      //
      // The explicit render is required: PIXI runs `preserveDrawingBuffer: false`, so the colour
      // buffer is only guaranteed valid inside the task that drew it. The two `requestAnimationFrame`
      // waits around it are a precaution, not a measured fix — the mini-game runtime decides for
      // itself when a frame is composited, and a snapshot taken in the same task as the render is
      // the one shape that could plausibly hand back an older composite. Cheap (two frames per
      // stop), and it removes one explanation from the list whenever a PNG and the audit disagree.
      await frame();
      app.renderer.render(app.stage);
      await frame();
      const tmp = canvas.toTempFilePathSync({ fileType: 'png' });
      fs.copyFileSync(tmp, dest);
      return;
    }
  } catch (e) {
    if (shotErrors.length < 8) shotErrors.push(`${name}: toTempFilePathSync — ${String(e)}`);
  }
  // Path B — PixiJS's own extractor. Measured 2026-09-12: it throws `ImageData is not defined` in
  // this runtime (`Extract.canvas` builds one to hand to `putImageData`), so it is the fallback,
  // not the first choice. Kept because it is the path that works if the screen canvas ever stops
  // answering, and because a recorded error beats a silent absence: a green report with no pictures
  // is exactly the state §50.11's lesson warns about (the sweep's last three real defects were all
  // found by READING PNGs of stops the gate had just called clean).
  try {
    const dataUrl = await Promise.resolve(
      (app.renderer as unknown as {
        extract: { base64(target: unknown, format?: string): string | Promise<string> };
      }).extract.base64(app.stage, 'image/png'),
    );
    const comma = dataUrl.indexOf(',');
    if (comma < 0) throw new Error('extract.base64 returned no data: prefix');
    fs.writeFileSync(dest, dataUrl.slice(comma + 1), 'base64');
  } catch (e) {
    if (shotErrors.length < 8) shotErrors.push(`${name}: extract — ${String(e)}`);
  }
}

/**
 * Boot gates → lobby. Written as a loop over whatever screen is currently up rather than as a fixed
 * sequence, because the order is a product decision that has moved twice (intro → age gate →
 * consent → login, plus the FTUE redirect that lands a brand-new account in the tutorial LEVEL
 * rather than the lobby — see `registerAndEnterLobby` in test/browser/lib/nwE2E.ts). A loop absorbs
 * a reorder; a fixed sequence times out on it.
 */
async function reachLobby(handle: E2EHandle, deadlineMs: number): Promise<string | null> {
  const state = handle.state;
  const until = Date.now() + deadlineMs;
  const loginId = `wxlayout${Math.floor(Math.random() * 1e9)}`;
  let registered = false;
  let last = '';
  /** Recorded, not thrown: the walk still runs (offline) and the report still says what went wrong. */
  let error: string | null = null;
  while (Date.now() < until) {
    const screen = typeof state.screen === 'string' ? state.screen : '?';
    if (screen !== last) { log(`boot: ${screen}`); last = screen; }
    if (screen === 'lobby') return error;
    const bag = state[`${screen}Cb`] as Record<string, (...a: unknown[]) => unknown> | undefined;
    try {
      if (screen === 'intro' && bag?.onFinish) bag.onFinish(true);
      else if (screen === 'ageGate' && bag?.onDeclared) bag.onDeclared(new Date().getFullYear() - 30);
      else if (screen === 'consent' && bag?.onAccept) bag.onAccept();
      else if (screen === 'game' && bag?.onExitToLobby) bag.onExitToLobby();
      else if (screen === 'login' && bag?.onRegister && !registered) {
        registered = true;
        const res = await bag.onRegister(loginId, 'password123', 'WxLayout') as { ok?: boolean };
        log(`register ${loginId}: ${JSON.stringify(res)}`);
        // A failed registration is the single most likely way this run goes wrong, and it is the
        // one failure that looks like a layout problem three minutes later (every stop "gated").
        // Record it and fall back to offline — a thin sweep still measures the lobby, the campaign
        // and the battle, which is more than nothing.
        //
        // Deliberately NOT a `return`: the loop has to keep running until the lobby is actually up.
        // Returning here once meant `walkLayout` began auditing while the login screen (and then
        // the FTUE tutorial LEVEL) was still on screen — every stop after it measured the wrong
        // picture, and the report's two findings were the tutorial's own overlay text.
        if (res?.ok !== true) {
          error = `register failed: ${JSON.stringify(res)}`;
          if (bag.onPlayOffline) bag.onPlayOffline();
        }
      }
    } catch (e) {
      return `boot step on '${screen}' threw: ${String(e)}`;
    }
    await sleep(300);
  }
  return error ?? `never reached the lobby (stuck on '${last}')`;
}

async function run(handle: E2EHandle): Promise<void> {
  try { fs.mkdirSync(OUT_DIR, true); } catch { /* already there */ }
  const bootError = await reachLobby(handle, 90_000);
  if (bootError) log(`boot: ${bootError}`);
  const result = await walkLayout({ handle, label, capture, log });
  if (bootError) result.errors.unshift(bootError);
  if (shotErrors.length) result.errors.push(`screenshots failed: ${shotErrors.join(' | ')}`);

  const lines = result.reports.flatMap((r) =>
    r.findings.map((f) => `${r.screen}: ${f.kind} "${f.a}" ${f.b}`));
  const report = {
    when: new Date().toISOString(),
    system: (() => { try { return wx.getSystemInfoSync(); } catch (e) { return { error: String(e) }; } })(),
    screen: {
      width: handle.app?.renderer.screen.width ?? 0,
      height: handle.app?.renderer.screen.height ?? 0,
      resolution: handle.app?.renderer.resolution ?? 0,
      designScale: handle.scaling?.gameLayer.scale.x ?? 0,
    },
    stops: result.reports.length,
    findingCount: lines.length,
    ...result,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2), 'utf8');
  // Three independent exits, same reasoning as `wechat-e2e.ts`: the FILE is the only headless one,
  // `GameGlobal` is the reach for anyone with a console attached, and the console line is what
  // tells a human the probe ran at all — nothing on disk is equally consistent with "it crashed"
  // and "the simulator never ran it", and those need very different fixes.
  (globalThis as unknown as { nwLayoutReport?: unknown }).nwLayoutReport = report;
  log(`done: ${result.reports.length} stops, ${lines.length} finding(s), ` +
      `${result.skipped.length} skipped, ${result.errors.length} error(s) → ${OUT_FILE}`);
  for (const l of lines.slice(0, 40)) log(l);
}

startApp(new LayoutProbePlatform(), (views) => instrumentViews(views).views)
  .then(() => {
    const handle = (globalThis as unknown as { __nwE2E: E2EHandle }).__nwE2E;
    return run(handle);
  })
  .catch((e: unknown) => {
    log(`FAILED: ${String(e)}`);
    try {
      fs.writeFileSync(OUT_FILE, JSON.stringify({ fatal: String(e) }, null, 2), 'utf8');
    } catch { /* nothing left to try */ }
  });
