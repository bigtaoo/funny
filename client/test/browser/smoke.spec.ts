// Browser smoke (claudedocs/client-testing.md 缺口B) — the only test layer that drives a real
// PixiJS renderer / real WebGL, via the test-only entries/web-e2e.ts (window.__nwE2E). Two happy
// paths, no pixel-diff: catch white-screen-class failures (shader/atlas/GPU) that headless
// test:ui can't reach, and — since this is a solo project with no dedicated tester — automate the
// "log in two accounts and walk the core path" smoke that used to be manual.
//
// Prereq: a running server stack, same as test:e2e (`npm run dev:all` in server/, dev-up.ps1).
// The Playwright webServer only boots the client's own dev server (web-e2e target); it does NOT
// start the backend.
//
// Run: npm run test:browser   (NOT part of `npm test`; opt-in, real browser + real network).

import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

declare global {
  interface Window {
    __nwE2E?: { state: Record<string, any> };
  }
}

function uid(prefix: string): string {
  return `${prefix}${Math.floor(Math.random() * 1e9)}`;
}

/** Collects console `error` lines + uncaught page errors for the test's whole lifetime. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`);
  });
  page.on('pageerror', (err: Error) => errors.push(`[pageerror] ${err.message}`));
  return errors;
}

async function screenIs(page: Page, name: string): Promise<void> {
  await page.waitForFunction(
    (s: string) => window.__nwE2E?.state?.screen === s,
    name,
    { timeout: 20_000 },
  );
}

/** intro → consent gate, both unconditional on a fresh (storage-less) browser context. */
async function bootToLogin(page: Page): Promise<void> {
  await page.goto('/');
  await screenIs(page, 'intro');
  await page.evaluate(() => window.__nwE2E!.state.introCb.onFinish(true));
  await screenIs(page, 'consent');
  await page.evaluate(() => window.__nwE2E!.state.consentCb.onAccept());
  await screenIs(page, 'login');
}

/** Mirrors full-link.e2e.ts's registerAndEnterLobby, driven via window.__nwE2E instead of headless views. */
async function registerAndEnterLobby(page: Page, loginId: string, displayName: string): Promise<void> {
  await bootToLogin(page);
  const outcome = await page.evaluate(
    ([id, name]: string[]) => window.__nwE2E!.state.loginCb.onRegister(id, 'password123', name),
    [loginId, displayName],
  );
  expect(outcome.ok, `register failed: ${JSON.stringify(outcome)}`).toBe(true);
  await screenIs(page, 'lobby');
}

test.describe('browser smoke — real renderer', () => {
  test('single account: register → lobby → local battle renders with no console errors', async ({ page }) => {
    const errors = trackErrors(page);
    await registerAndEnterLobby(page, uid('smoke'), 'Smoke');

    // onStartGame is gated by the first-time feature guide (ONBOARDING_DESIGN §4.1) on a fresh
    // account; dismiss it via the generic showFeatureGuide(...)Cb captured on the lobby handle.
    await page.evaluate(() => window.__nwE2E!.state.lobbyCb.onStartGame('AI'));
    await page.waitForFunction(() => !!window.__nwE2E?.state?.showFeatureGuideCb, null, { timeout: 5_000 }).catch(() => {});
    const hasGuide = await page.evaluate(() => !!window.__nwE2E!.state.showFeatureGuideCb);
    if (hasGuide) await page.evaluate(() => window.__nwE2E!.state.showFeatureGuideCb());

    await screenIs(page, 'game');
    // Let the real GameRenderer run a few real ticks (board/units/buildings/HUD/VFX, real WebGL
    // draw calls) — this is the white-screen-class exposure headless test:ui structurally can't reach.
    await page.waitForTimeout(2_000);

    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('two accounts: friendly room → real PvP match renders on both real renderers', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    const errorsA = trackErrors(a);
    const errorsB = trackErrors(b);

    try {
      await registerAndEnterLobby(a, uid('host'), 'Host');
      await registerAndEnterLobby(b, uid('guest'), 'Guest');

      await a.evaluate(() => window.__nwE2E!.state.lobbyCb.onOpenRoom());
      await screenIs(a, 'room');
      await a.waitForFunction(() => window.__nwE2E?.state?.lastNetState === 'open', null, { timeout: 15_000 });
      await a.evaluate(() => window.__nwE2E!.state.roomCb.createRoom());
      await a.waitForFunction(() => !!window.__nwE2E?.state?.lastRoomState?.code, null, { timeout: 15_000 });
      const code = await a.evaluate(() => window.__nwE2E!.state.lastRoomState.code as string);

      await b.evaluate(() => window.__nwE2E!.state.lobbyCb.onOpenRoom());
      await screenIs(b, 'room');
      await b.waitForFunction(() => window.__nwE2E?.state?.lastNetState === 'open', null, { timeout: 15_000 });
      await b.evaluate((c: string) => window.__nwE2E!.state.roomCb.joinRoom(c), code);

      await a.waitForFunction(() => (window.__nwE2E?.state?.lastRoomState?.players?.length ?? 0) >= 2, null, { timeout: 15_000 });
      await b.waitForFunction(() => (window.__nwE2E?.state?.lastRoomState?.players?.length ?? 0) >= 2, null, { timeout: 15_000 });

      await a.evaluate(() => window.__nwE2E!.state.roomCb.setReady(true));
      await b.evaluate(() => window.__nwE2E!.state.roomCb.setReady(true));

      await screenIs(a, 'gameNet');
      await screenIs(b, 'gameNet');

      // Both sides now run a real netplay match against real gateway/matchsvc/gameserver, each with
      // its own real WebGL renderer — the highest-density "two real accounts" path in the game.
      await a.waitForTimeout(2_000);

      expect(errorsA, errorsA.join('\n')).toEqual([]);
      expect(errorsB, errorsB.join('\n')).toEqual([]);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
