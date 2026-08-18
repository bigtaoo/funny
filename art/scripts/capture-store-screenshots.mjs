// Capture app-store screenshots straight out of the real game, at exact device pixel sizes.
//
// Why this instead of screen-recording a phone: the client is fully responsive, so rendering it
// into a viewport that IS the store's required resolution gives native pixels (no upscaling), and
// covers sizes we own no hardware for (iPad 12.9"). Scenes are driven through the test-only
// `web-e2e` entry (`window.__nwE2E`, see client/src/entries/web-e2e.ts) rather than by clicking
// canvas coordinates — the whole game is one <canvas>, so there is nothing else to click.
//
// Prereqs — a local backend + the e2e client dev server. No Docker needed:
//   1. Mongo as a SINGLE-NODE REPLICA SET (worldsvc needs transactions; the shared default URI
//      already asks for ?replicaSet=rs0, so run it on 27017 and no env override is needed):
//        ~/.cache/mongodb-binaries/mongod-x64-win32-<ver>.exe \
//          --replSet rs0 --dbpath <scratch>/mongo-data --port 27017 --bind_ip 127.0.0.1
//      then once: db.adminCommand({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] } })
//   2. npx tsc -b shared           (from server/, so services can import @nw/shared)
//   3. three services, each `node --import tsx src/index.ts` from its own dir:
//        metaserver  NW_COMMERCIAL_INTERNAL_URL=http://127.0.0.1:18082
//        commercial  (no extra env)
//        worldsvc    NW_WORLD_PORT=18084 NW_META_INTERNAL_URL=http://127.0.0.1:18080 \
//                    NW_COMMERCIAL_INTERNAL_URL=http://127.0.0.1:18082
//      Redis is optional — every service logs `redis=off` and degrades cleanly.
//   4. client dev server on 9096:  npm --prefix client run start:e2e
//   5. an account with progress: register once through the UI (or a prior run of this script),
//      then `node art/scripts/seed-screenshot-account.cjs <loginId>`.
//
// Run:  node art/scripts/capture-store-screenshots.mjs <loginId> <outDir> [deviceName]
// Out:  <outDir>/<scene>__<device>.png
//
// Coins: the account is topped up in-run through the dev IAP stub (`shopCb.recharge(<any code>)`
// → iapVerify('dev', code), +1100 each) so the economy screens aren't shown at a 0 balance.

import pw from 'file:///D:/funny/client/node_modules/@playwright/test/index.js';
import { mkdirSync } from 'node:fs';
const { chromium } = pw;
const [LOGIN, OUT, ONLY] = process.argv.slice(2);
if (!LOGIN || !OUT) { console.error('usage: node capture-store-screenshots.mjs <loginId> <outDir> [device]'); process.exit(1); }

// Exact store-required pixel sizes. iPhone 6.7"/6.5" and the 12.9" iPad are Apple's slots;
// 1080x1920 is the Google Play phone screenshot baseline.
const DEVICES = [
  { name: 'iphone_6.7', width: 1290, height: 2796 },
  { name: 'iphone_6.5', width: 1242, height: 2688 },
  { name: 'ipad_12.9',  width: 2048, height: 2732 },
  { name: 'android_9x16', width: 1080, height: 1920 },
].filter((d) => !ONLY || d.name === ONLY);

mkdirSync(OUT, { recursive: true });
// swiftshader: this box has no real GPU in a headless context; ANGLE's software path renders the
// same PixiJS output, just slower.
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

for (const dev of DEVICES) {
  const ctx = await browser.newContext({ viewport: { width: dev.width, height: dev.height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 120)));

  const screen = () => page.evaluate(() => window.__nwE2E?.state?.screen);
  const wait = (ms) => page.waitForTimeout(ms);
  const waitScreen = (s, t = 30000) => page.waitForFunction((x) => window.__nwE2E?.state?.screen === x, s, { timeout: t });
  // The first-time feature guide gates most lobby entries, and fires per feature, not per session.
  const guide = () => page.evaluate(() => window.__nwE2E.state.showFeatureGuideCb?.());
  const call = (fn, ...a) => page.evaluate(([f, args]) => {
    const st = window.__nwE2E.state; const cb = st[st.screen + 'Cb'];
    return cb && typeof cb[f] === 'function' ? cb[f](...args) : Promise.resolve('NO_FN:' + f);
  }, [fn, a]);
  const backToLobby = async () => { for (let i = 0; i < 6; i++) { if (await screen() === 'lobby') return; await call('onBack'); await wait(1300); } };
  const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}__${dev.name}.png` }); console.log(`  shot ${name} (${await screen()})`); };

  console.log(`== ${dev.name} ${dev.width}x${dev.height}`);
  await page.goto('http://localhost:9096/', { waitUntil: 'load' });
  await waitScreen('intro');
  await page.evaluate(() => window.__nwE2E.state.introCb.onFinish(true));
  await waitScreen('consent');
  await page.evaluate(() => window.__nwE2E.state.consentCb.onAccept());
  await waitScreen('login');
  await page.evaluate(([id]) => window.__nwE2E.state.loginCb.onLogin(id, 'password123'), [LOGIN]);
  await wait(4000);
  // goLobby() re-routes into the FTUE tutorial once more after boot assets finish, so escaping it
  // is a loop, not a single call.
  for (let i = 0; i < 8; i++) { const s = await screen(); if (s === 'lobby') break; if (s === 'game') await page.evaluate(() => window.__nwE2E.state.gameCb.onExitToLobby()); await wait(1500); }
  await wait(2500);

  // coins first, so every later screen shows a non-zero balance
  await page.evaluate(() => window.__nwE2E.state.lobbyCb.onOpenShop()); await wait(2500); await guide(); await wait(1200);
  await call('openCoins'); await wait(2000); await guide(); await wait(1200);
  for (let i = 0; i < 6; i++) { await page.evaluate(() => { const st = window.__nwE2E.state; return st[st.screen + 'Cb'].recharge('dev-' + Math.random().toString(36).slice(2)); }); await wait(1200); }
  console.log('  coins:', await call('getCoins'));
  await backToLobby(); await wait(1500);

  await shot('lobby');

  await page.evaluate(() => window.__nwE2E.state.lobbyCb.onOpenCampaign()); await wait(2500); await guide(); await wait(2000);
  await shot('campaign');

  // level select → loadout prep → the battle itself; the wait lets both sides get units on the field
  await call('onSelectLevel', 'ch2_lv5'); await wait(2500);
  if (await screen() === 'levelPrep') { await shot('prep'); await call('onStart'); await wait(3000); }
  if (await screen() === 'game') { await wait(14000); await shot('battle'); await page.evaluate(() => window.__nwE2E.state.gameCb.onExitToLobby()); await wait(3000); }
  else console.log('  battle skipped, screen =', await screen());
  await backToLobby();

  // Shop and gacha share one hub; onOpenShop() can land on either, openShop() moves across.
  await page.evaluate(() => window.__nwE2E.state.lobbyCb.onOpenShop()); await wait(3000); await guide(); await wait(2500);
  await shot('gacha');
  await call('openShop'); await wait(2500); await guide(); await wait(2000);
  await shot('shop');
  await backToLobby();

  await page.evaluate(() => window.__nwE2E.state.lobbyCb.onOpenWorld()); await wait(4000); await guide(); await wait(6000);
  await shot('world');

  await ctx.close();
}
await browser.close();
console.log('done ->', OUT);
