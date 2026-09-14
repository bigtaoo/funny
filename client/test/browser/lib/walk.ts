// walk.ts — how a Playwright process gets from the lobby to a `Stop` and back.
//
// `src/testing/layoutStops.ts` holds WHERE the sweeps go; this holds HOW one browser-driven sweep
// gets there. The split already existed in that file's header (the WeChat in-package probe owns the
// other "how"), but both halves of the browser side lived inside `portraitLayout.spec.ts` — so the
// second browser sweep to want them (`bakeBudget.spec.ts`, which walks the same stops to measure
// the bake cache rather than to audit labels) would have had to copy a hundred lines of navigation,
// including the two non-obvious waits below that each cost a round of wrong results to find.
//
// Nothing here judges anything. A caller decides what to do at each stop.
import type { Page } from '@playwright/test';
import { currentScreen, callCb, dismissFeatureGuide, tapLabel, screenIs } from './nwE2E';
// The dictionaries themselves, not the i18n module: `t()` keeps the CURRENT locale in module state
// and this process has none. A stop that taps a label has to know what that label says in the
// locale the browser was booted in — see `Hop`'s tap form.
import { zh, type TranslationKey } from '../../../src/i18n/locales/zh';
import { en } from '../../../src/i18n/locales/en';
import { de } from '../../../src/i18n/locales/de';
import { type Stop } from '../../../src/testing/layoutStops';

export const DICTS = { zh, en, de } as const;
export type Locale = keyof typeof DICTS;

/** How long a tap hop waits for its label to appear before calling the stop unreachable. */
const TAP_WAIT_MS = 6_000;

/** The literal, parameter-free prefix of a label in one locale — what `tapLabel` can match on. */
export function label(locale: Locale, key: TranslationKey): string {
  const raw = DICTS[locale][key] ?? DICTS.zh[key] ?? key;
  return raw.split('{')[0]!.trim();
}

/**
 * Walks one stop's `via` chain from the lobby, clearing the first-time feature guide that sits in
 * front of most entries on a fresh account (ONBOARDING_DESIGN §4.1) — it is shown INSTEAD of
 * navigating, so the entry has to be tapped again after it. Returns the screen finally reached, or
 * null if a hop is not wired (gated feature) or never lands.
 */
export async function open(page: Page, stop: Stop, locale: Locale): Promise<string | null> {
  let from = await currentScreen(page);
  for (const hop of stop.via) {
    if (typeof hop === 'object' && ('tap' in hop || 'tapText' in hop)) {
      // A tap opens a modal (or a tab) on the SAME screen, so there is no screen change to wait
      // for — settle, re-read whatever `state.screen` says, and let the caller judge what is now on
      // top of it. A label that isn't there is a navigation failure like any other.
      //
      // A tab CAN navigate, though (the family tab hands straight off to the family hub once the
      // player has a family), so the re-read matters: `state.screen` after the settle is the answer
      // either way.
      const text = 'tap' in hop ? label(locale, hop.tap) : hop.tapText;
      // Polled rather than tapped once (2026-09-12). A tap hop that follows a navigation hop fires
      // the instant `state.screen` changes — which, for a list the server fills in (the mail list),
      // is before any row exists. `friends+mailRead` was recorded as an unreachable stop for a whole
      // round because of it, while the screenshot of the stop before it showed the very label this
      // was looking for. Modals inside a scene are built synchronously and hit on the first pass, so
      // this costs them nothing.
      const deadline = Date.now() + TAP_WAIT_MS;
      let tapped = await tapLabel(page, text);
      while (!tapped && Date.now() < deadline) {
        await page.waitForTimeout(250);
        tapped = await tapLabel(page, text);
      }
      if (!tapped) return null;
      await page.waitForTimeout(800);
      from = await currentScreen(page);
      continue;
    }
    const fn = typeof hop === 'string' ? hop : hop.fn;
    const args = typeof hop === 'string' ? [] : hop.args ?? [];
    const bag = `${from}Cb`;
    if (!await callCb(page, bag, fn, args)) return null;
    if (typeof hop === 'object' && hop.stay) {
      // Deliberately no screen change: an overlay mounted on `app.stage`, or a loader the next hop
      // depends on. `callCb` has already awaited whatever it returned.
      from = await currentScreen(page);
      continue;
    }
    const deadline = Date.now() + 10_000;
    let landed: string | null = null;
    while (Date.now() < deadline) {
      const now = await currentScreen(page);
      if (now !== from) { landed = now; break; }
      if (await dismissFeatureGuide(page)) await callCb(page, bag, fn, args);
      await page.waitForTimeout(200);
    }
    if (landed === null) return null;
    from = landed;
  }
  return from;
}

/** What the page thinks it is showing — the readable half of a navigation failure. */
export async function whereAmI(page: Page): Promise<string> {
  return page.evaluate(() => {
    const s = window.__nwE2E?.state ?? {};
    const cbs = Object.keys(s).filter((k) => k.endsWith('Cb')).join(',');
    return `screen=${s.screen} cbs=[${cbs}]`;
  });
}

/**
 * Back to the lobby by whichever exit each scene offers, unwinding however deep the stop went.
 *
 * Returns true when it had to fall back to a RELOAD. Callers that only look at the screen can
 * ignore it; a caller measuring anything the page owns cannot, because a reload throws away the
 * renderer and everything cached against it (see `bakeBudget.spec.ts`).
 */
export async function backToLobby(page: Page): Promise<boolean> {
  for (let depth = 0; depth < 4; depth++) {
    const screen = await currentScreen(page);
    if (screen === 'lobby') return false;
    let moved = false;
    for (const fn of ['onBack', 'onExit', 'onClose', 'onExitToLobby']) {
      if (!await callCb(page, `${screen}Cb`, fn)) continue;
      try {
        await page.waitForFunction(
          (s: string) => window.__nwE2E?.state?.screen !== s, screen, { timeout: 5_000 },
        );
        moved = true;
        break;
      } catch { /* try the next exit name */ }
    }
    if (!moved) break;
  }
  if (await currentScreen(page) !== 'lobby') {
    // The session is persisted, so a reload lands straight back in the lobby.
    await page.reload();
    await screenIs(page, 'lobby', 20_000);
    return true;
  }
  return false;
}
