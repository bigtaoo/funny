// Browser smoke — BGM ducking wired end to end against a REAL stinger cue (AUDIO_DESIGN.md §4,
// §7 step 7). `MusicPlayer.test.ts` only proves the envelope math: it calls
// `player.requestDuck()`/`player.update()` directly, on a player built with mocked decks — it has
// no way to notice if `sfx.result.victory` ever stopped being a member of `DUCK_CUES`, or if
// `ContextAudioBus.play()` stopped calling `this.music?.requestDuck()` before it. That link (cue
// name → catalogue membership → real audio graph) can break silently: nothing fails to compile,
// nothing fails to build, the game still plays — the bed just quietly stops ducking for that cue,
// which per AUDIO_DESIGN.md's own audit-of-what-fails-to-notice-things reads as "the music is a
// bit odd", not as a bug.
//
// No backend needed — this only exercises the intro screen (which gets the default `bgm.lobby`
// track, AUDIO_DESIGN.md §2.3) plus the `window.__nwAudio` test hook (see entries/web-e2e.ts);
// never login/room/battle. It still can't tell you whether it SOUNDS right (a suspended
// AudioContext under CI is expected — ducking is judged outside that gate on purpose, see
// ContextAudioBus.play()'s comment — so this asserts the gain math, not what reached the speakers).
//
// ⚠️ Deliberately does NOT `declare global` on `Window` (claudedocs/client-testing.md's own
// history: two specs augmenting the same global in `tsconfig.test.json`'s shared program stomp on
// each other and the resulting errors land in the OTHER file). Local type + in-closure cast only —
// note the cast has to be re-stated inside every `page.evaluate`/`waitForFunction` callback, since
// those are serialized to a string and only the TYPE (erased at compile time) survives, never a
// module-scope value.

import { test, expect } from '@playwright/test';

interface MusicSnapshot {
  track: string | null;
  crossfading: boolean;
  duck: number;
  decks: { position: number | null; gain: number }[];
}
interface NwAudio {
  play(cue: string, count?: number): void;
  resume(): void;
  music(): MusicSnapshot | null;
  log(): { cue: string; count: number; t: number }[];
}
function nwAudio(): NwAudio {
  return (window as unknown as { __nwAudio: NwAudio }).__nwAudio;
}

function maxDeckGain(m: MusicSnapshot): number {
  return Math.max(...m.decks.map((d) => d.gain));
}

test.describe('browser smoke — BGM ducking against a real stinger', () => {
  test('sfx.result.victory ducks bgm.lobby and fully releases', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as unknown as { __nwAudio?: unknown }).__nwAudio !== undefined);

    // Real click — satisfies ContextAudioBus's `gestured` gate (a window-level pointerdown
    // listener), which `updateMusic` is behind. Ducking itself does NOT need this (it's judged
    // outside every gate), but the bed has to actually be playing for `decks[].gain` to mean
    // anything.
    await page.mouse.click(640, 360);
    await page.evaluate(() => {
      const na = (window as unknown as { __nwAudio: { resume(): void } }).__nwAudio;
      na.resume();
    });

    // Let the boot fade-in (XFADE_S = 2s, MusicPlayer.ts) settle before measuring.
    await page.waitForFunction(() => {
      const na = (window as unknown as { __nwAudio: { music(): MusicSnapshot | null } }).__nwAudio;
      const m = na.music();
      return m?.track === 'bgm.lobby' && !m.crossfading;
    }, null, { timeout: 10_000 });

    const before = await page.evaluate(() => {
      const na = (window as unknown as { __nwAudio: { music(): MusicSnapshot | null } }).__nwAudio;
      return na.music();
    });
    expect(before?.duck).toBe(1);
    const steadyGain = before ? maxDeckGain(before) : 0;
    expect(steadyGain).toBeCloseTo(0.5, 2); // bus(1) × duck(1) × trackGain(1) × busGain(0.5)

    await page.evaluate(() => {
      const na = (window as unknown as { __nwAudio: { play(cue: string): void } }).__nwAudio;
      na.play('sfx.result.victory');
    });

    const readMusic = () => page.evaluate(() => {
      const na = (window as unknown as { __nwAudio: { music(): MusicSnapshot | null } }).__nwAudio;
      return na.music();
    });

    // Attack is DUCK_ATTACK_MS = 80ms to DUCK_LEVEL = 0.45; hold is DUCK_HOLD_MS = 500ms from the
    // trigger. 200ms in is solidly past the attack and solidly inside the hold — wide margin
    // either side for CI scheduling jitter.
    await page.waitForTimeout(200);
    const ducked = await readMusic();
    expect(ducked!.duck).toBeGreaterThan(0.4);
    expect(ducked!.duck).toBeLessThan(0.5);
    expect(maxDeckGain(ducked!)).toBeCloseTo(steadyGain * 0.45, 2);

    // Still held at 400ms (hold doesn't expire until 500ms from the trigger).
    await page.waitForTimeout(200);
    const stillHeld = await readMusic();
    expect(stillHeld!.duck).toBeGreaterThan(0.4);
    expect(stillHeld!.duck).toBeLessThan(0.5);

    // Fully released by 500 (hold) + 700 (DUCK_RELEASE_MS) + generous margin. A duck that sticks
    // is a bed quietly 6.9 dB low forever, and nothing else in the pipeline would report it.
    await page.waitForTimeout(1300);
    const released = await readMusic();
    expect(released!.duck).toBe(1);
    expect(maxDeckGain(released!)).toBeCloseTo(steadyGain, 2);

    // The cue reached the real bus exactly once — a re-fire (e.g. from some future code path
    // calling play() again on the same event) would show up here before it showed up as a
    // perceptible double-hit.
    const log = await page.evaluate(() => {
      const na = (window as unknown as { __nwAudio: { log(): { cue: string }[] } }).__nwAudio;
      return na.log();
    });
    expect(log.filter((e) => e.cue === 'sfx.result.victory')).toHaveLength(1);
  });
});
