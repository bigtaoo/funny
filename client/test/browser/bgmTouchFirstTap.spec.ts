// Browser regression — the bed must start when a player's FIRST input is a touch tap inside the
// tutorial (AUDIO_DESIGN.md §5, the autoplay rows; found 2026-10-08).
//
// What broke: a touch `pointerdown` opened ContextAudioBus's music gate, but the start of a touch is
// not a user activation, so the next frame's `<audio>.play()` was refused (NotAllowedError). The
// deck went idle while MusicPlayer still believed the track was playing, and only a track change
// ever called `play()` again — the tutorial has one track, so a new player on CrazyGames (no entry
// screen to take the first tap) heard no music for the whole tutorial. SFX were fine: the context's
// `resume()` ran again on the touch's END and succeeded there.
//
// Why CDP instead of `page.evaluate`: Playwright's evaluate runs with a user gesture, which grants
// the page activation and hides exactly this bug. Every scripted step below goes through
// `Runtime.evaluate { userGesture: false }`, so the ONLY activation the page ever gets is the tap.
// The autoplay policy is pinned to the real-browser default for the same reason.
//
// No backend needed: the e2e entry's offline path drops a fresh player into the tutorial.
// ⚠️ No `declare global` on Window — see audioDucking.spec.ts's header for why.

import { test, expect, type CDPSession } from '@playwright/test';

test.use({
  hasTouch: true,
  // Tracing / failure screenshots grant the page user activation on their own (measured:
  // `navigator.userActivation.hasBeenActive` is already true right after `goto` with the config's
  // `trace: 'retain-on-failure'`), which would let the bed start without the tap and hide the bug.
  trace: 'off',
  screenshot: 'off',
  launchOptions: { args: ['--autoplay-policy=document-user-activation-required'] },
});

async function ev<T>(cdp: CDPSession, expression: string): Promise<T> {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: false });
  return r.result.value as T;
}

async function waitScreen(cdp: CDPSession, screen: string): Promise<void> {
  await expect.poll(() => ev<string | undefined>(cdp, 'window.__nwE2E?.state?.screen'), { timeout: 60_000 }).toBe(screen);
}

interface MusicSnapshot { track: string | null; decks: { position: number | null; gain: number }[] }

test('a first tap that is a touch still starts the tutorial bed', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await page.goto('/');
  await waitScreen(cdp, 'entryGate');
  await ev(cdp, 'window.__nwE2E.state.entryGateCb.onAnswered({ birthYear: new Date().getFullYear() - 30, granted: false })');
  await waitScreen(cdp, 'login');
  await ev(cdp, 'window.__nwE2E.state.loginCb.onPlayOffline()');
  await waitScreen(cdp, 'game');
  expect(await ev<boolean>(cdp, 'navigator.userActivation.hasBeenActive')).toBe(false);
  // Let the scene transition finish first. Tapped during it, the frame after the press still asks
  // for the previous scene's track, the bed then CHANGES track to the battle one — and a track change
  // calls `play()` again inside the touch's activation, so the old code passed by accident.
  await page.waitForTimeout(3000);

  // One ordinary finger tap: press, hold ~150 ms, release.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 640, y: 650 }] });
  await page.waitForTimeout(150);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

  // The live deck reports a position only while its stream is really playing; before the fix it
  // stayed null for the rest of the tutorial.
  const music = (): Promise<MusicSnapshot | null> => ev(cdp, 'window.__nwAudio.music()');
  await expect.poll(async () => {
    const m = await music();
    return m?.decks.some((d) => d.position !== null && d.position > 0.2) ?? false;
  }, { timeout: 15_000 }).toBe(true);
  expect((await music())?.track).toBe('bgm.battle.early');
  expect(await ev<string>(cdp, 'window.__nwE2E.state.screen')).toBe('game');
});
