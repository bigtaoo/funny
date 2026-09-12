// Browser smoke — the OS audio session (AUDIO_DESIGN.md §5, the audio-session row).
//
// Reported 2026-09-11: opening the game on a phone stops whatever the player had playing. The fix
// has two halves — declare `navigator.audioSession = 'ambient'` so iOS lets us mix
// (`platform/web/WebAudioBus.ts`), and never HOLD the session while making no sound
// (`audio/ContextAudioBus.ts`). This spec covers the second half against a real `AudioContext`,
// because that is the half whose truth lives in the browser rather than in our code:
// `ContextAudioBus.test.ts` asserts that we call `suspend()`/`resume()` on a FAKE context, which
// is exactly as true on a build where the real thing rejects both calls and stays `running`
// forever. The whole point of the change is a state a fake cannot have.
//
// It cannot check the part that matters most to the reporter — whether Spotify keeps playing —
// because that needs iOS and a second app. What it can check is the mechanism that decides it.
//
// No backend needed: intro screen plus the `window.__nwAudio` hook (see entries/web-e2e.ts).
//
// ⚠️ No `declare global` on `Window`, same as `audioDucking.spec.ts` — see that file's header for
// why (two specs augmenting the same global in one tsconfig program stomp on each other).

import { test, expect } from '@playwright/test';

/** `__nwAudio.nodes()`, narrowed to what this spec reads. */
interface NwNodes {
  ctx: { state: string } | null;
}

/** The live context state, or a marker for "no context at all" (never expected after a gesture). */
async function contextState(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const na = (window as unknown as { __nwAudio: { nodes(): NwNodes } }).__nwAudio;
    return na.nodes().ctx?.state ?? 'none';
  });
}

/** Fake a tab switch: `document.hidden` is read-only, so the getter is replaced for the event. */
async function setHidden(page: import('@playwright/test').Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test.describe('browser smoke — the OS audio session', () => {
  test('backgrounding suspends the real context, and coming back resumes it', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as unknown as { __nwAudio?: unknown }).__nwAudio !== undefined);

    // Real click for the `gestured` gate, then `resume()` for the autoplay gate.
    await page.mouse.click(640, 360);
    await page.evaluate(() => {
      const na = (window as unknown as { __nwAudio: { resume(): void } }).__nwAudio;
      na.resume();
    });

    // Whether a synthetic click counts as user activation is a browser/launch-flag decision, not
    // ours (`audioDucking.spec.ts` records that a suspended context under CI is the normal case).
    // So this is a precondition, not an assertion: without a running context there is no session
    // being held and nothing for the rest of the case to observe.
    const unlocked = await page
      .waitForFunction(() => {
        const na = (window as unknown as { __nwAudio: { nodes(): NwNodes } }).__nwAudio;
        return na.nodes().ctx?.state === 'running';
      }, null, { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!unlocked, 'this browser never left the autoplay lock — nothing holds a session');

    await setHidden(page, true);
    // `suspend()` is async — the state flips when the audio thread has actually let go.
    await expect.poll(() => contextState(page), { timeout: 5_000 }).toBe('suspended');

    await setHidden(page, false);
    await expect.poll(() => contextState(page), { timeout: 5_000 }).toBe('running');
  });
});
