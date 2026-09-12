// Shared driving helpers for the real-browser specs — the boot/register path and the generic
// "call a scene callback and wait for the screen to change" primitive, both against
// `window.__nwE2E` (entries/web-e2e.ts). Extracted from smoke.spec.ts when portraitLayout.spec.ts
// needed the same login walk; the two specs must stay on ONE copy of it, since the sequence
// encodes real product gates (intro → age gate → consent → FTUE tutorial → feature guides) that
// shift as onboarding changes.

import { expect, type Page, type ConsoleMessage } from '@playwright/test';

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __nwE2E?: { state: Record<string, any> };
  }
}

export function uid(prefix: string): string {
  return `${prefix}${Math.floor(Math.random() * 1e9)}`;
}

/** Collects console `error` lines + uncaught page errors for the test's whole lifetime. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`);
  });
  page.on('pageerror', (err: Error) => errors.push(`[pageerror] ${err.message}`));
  return errors;
}

export async function screenIs(page: Page, name: string, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    (s: string) => window.__nwE2E?.state?.screen === s,
    name,
    { timeout },
  );
}

export async function currentScreen(page: Page): Promise<string> {
  return page.evaluate(() => window.__nwE2E?.state?.screen ?? '?');
}

/** intro → age gate → consent gate, all unconditional on a fresh (storage-less) browser context. */
export async function bootToLogin(page: Page): Promise<void> {
  await page.goto('/');
  await screenIs(page, 'intro');
  await page.evaluate(() => window.__nwE2E!.state.introCb.onFinish(true));
  await screenIs(page, 'ageGate');
  await page.evaluate(() => {
    window.__nwE2E!.state.ageGateCb.onDeclared(new Date().getFullYear() - 30);
  });
  await screenIs(page, 'consent');
  await page.evaluate(() => window.__nwE2E!.state.consentCb.onAccept());
  await screenIs(page, 'login');
}

/**
 * Mirrors full-link.e2e.ts's registerAndEnterLobby, driven via window.__nwE2E instead of headless
 * views — with one addition full-link.e2e.ts doesn't need: a genuinely fresh account (no
 * `tutorial_done` flag surviving ADR-056's reconcile() rewrite — see the 2026-07-29
 * `HeadlessAppViews.showGame` fix, commit e5093451) gets redirected by `goLobby()` into the FTUE
 * tutorial level instead of the lobby (ONBOARDING_DESIGN §2 step ⑤) — `showGame()` fires with
 * `screen: 'game'`, and `screen` never becomes `'lobby'` on its own. `full-link.e2e.ts` never
 * needed to handle this because that fix lives IN the headless harness itself
 * (`HeadlessAppViews.showGame` auto-calls `onExitToLobby()` for a tutorial level); this is a real
 * app driving a real renderer, so there's no harness layer to intercept it — the test has to
 * explicitly dismiss the tutorial the way a player would, exactly like
 * GameSceneCallbacks.onExitToLobby (see `app/nav/game.ts`'s `goTutorial()`).
 */
export async function registerAndEnterLobby(page: Page, loginId: string, displayName: string): Promise<void> {
  await bootToLogin(page);
  const outcome = await page.evaluate(
    ([id, name]: string[]) => window.__nwE2E!.state.loginCb.onRegister(id, 'password123', name),
    [loginId, displayName],
  );
  expect(outcome.ok, `register failed: ${JSON.stringify(outcome)}`).toBe(true);

  await page.waitForFunction(
    () => window.__nwE2E?.state?.screen === 'lobby' || window.__nwE2E?.state?.screen === 'game',
    null,
    { timeout: 20_000 },
  );
  if (await page.evaluate(() => window.__nwE2E!.state.screen === 'game')) {
    // Fresh account landed in the FTUE tutorial level — skip it, same as a player tapping "skip".
    await page.evaluate(() => window.__nwE2E!.state.gameCb.onExitToLobby());
  }
  await screenIs(page, 'lobby');
}

/**
 * Invokes `state.<bag>.<fn>(...args)` in the page — the generic form of what the smoke test writes
 * out by hand (`state.lobbyCb.onStartGame('AI')`). Returns whether the callback existed, so a
 * caller sweeping optional entries (`onOpenAuction?`, wired online-only) can record "not offered"
 * instead of failing.
 */
export async function callCb(
  page: Page, bag: string, fn: string, args: unknown[] = [],
): Promise<boolean> {
  return page.evaluate(
    async ({ bag: b, fn: f, args: a }: { bag: string; fn: string; args: unknown[] }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const target = window.__nwE2E?.state?.[b] as Record<string, any> | undefined;
      if (!target || typeof target[f] !== 'function') return false;
      // Awaited when it returns a promise (2026-09-11). Several callbacks are the *loader* for the
      // screen behind them rather than the navigation itself — FriendsSceneCallbacks.loadSLGStatus is
      // what resolves the caller's shard id, and `openFamilyHub` returns false until it has. Firing
      // and moving on made those two-hop entries a race the sweep lost silently, recording the family
      // and sect hubs as "not offered by this account" for two rounds. A rejection is swallowed: the
      // callback existed and ran, which is all this return value claims.
      try { await target[f](...a); } catch { /* the screen's own error handling owns this */ }
      return true;
    },
    { bag, fn, args },
  );
}

/**
 * Taps the on-screen label whose text contains `needle`, by walking the real display tree for it
 * and clicking its centre. Returns false when no visible label matches.
 *
 * The callback bags (`state.<screen>Cb`) are the navigation graph between SCREENS, and that is all
 * they are: a modal — a city building's detail card, a hero's detail sheet, a gacha reveal — is
 * opened by a hit rect inside the scene, is never a screen, and therefore has no callback anywhere
 * for a sweep to call. Tapping is how a player opens one and it is how this does too: a real
 * pointer event at real coordinates, through the real InputManager and the scene's own hit table.
 * Addressing the target by its label (rather than by a rect the test would have to know) keeps the
 * stop table readable and keeps it out of the business of scene internals.
 *
 * Topmost match wins on ties by `order` — the last one painted is the one a player's finger would
 * reach, which matters once a modal is already up.
 */
export async function tapLabel(page: Page, needle: string): Promise<boolean> {
  const pt = await page.evaluate((text: string) => {
    interface N {
      visible: boolean; alpha: number; name: string | null; text?: unknown; children?: N[];
      getBounds(skipUpdate?: boolean): { x: number; y: number; width: number; height: number };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app = (window as any).__nwE2E?.app as { stage: N } | undefined;
    if (!app) return null;
    const best: { x: number; y: number } = { x: NaN, y: NaN };
    const walk = (n: N): void => {
      if (!n.visible || n.alpha <= 0.02) return;
      const own = typeof n.text === 'string' ? n.text
        : typeof n.name === 'string' && n.name.indexOf('txt:') === 0 ? n.name.slice(4)
        : null;
      if (own !== null && own.indexOf(text) >= 0) {
        const b = n.getBounds(false);
        if (b.width > 0 && b.height > 0) {
          best.x = b.x + b.width / 2;
          best.y = b.y + b.height / 2;
        }
      }
      const kids = n.children;
      if (kids) for (const k of kids) walk(k);
    };
    walk(app.stage);
    return Number.isFinite(best.x) ? best : null;
  }, needle);
  if (pt === null) return false;
  await page.mouse.click(pt.x, pt.y);
  return true;
}

/**
 * Dismisses the first-time feature guide (ONBOARDING_DESIGN §4.1) if one is up. Most
 * lobby-reachable features sit behind one on a fresh account, and it is shown INSTEAD of
 * navigating — so a sweep that doesn't clear it just sees the lobby again.
 */
export async function dismissFeatureGuide(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const cb = window.__nwE2E?.state?.showFeatureGuideCb;
    if (typeof cb !== 'function') return false;
    window.__nwE2E!.state.showFeatureGuideCb = undefined;
    cb();
    return true;
  });
}
