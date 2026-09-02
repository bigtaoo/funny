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

    // ── Why this waits on the STATE and not on the clock (fixed 2026-09-02) ────────────────────
    //
    // This section used to be three `waitForTimeout`s asserting a fixed duck value at a fixed
    // moment ("200ms in: 0.4 < duck < 0.5", "still held at 400ms", "released by 1800ms"), with a
    // comment claiming "wide margin either side for CI scheduling jitter". That claim was wrong in
    // both directions and the test failed 2 runs in 3 on a developer machine:
    //
    //   * The envelope does not advance on the wall clock. `advanceDuck` consumes the RENDER
    //     ticker's accumulated `dtMs`, so what the assertion is really about is how much the
    //     ticker has ticked — which diverges from `waitForTimeout` on every dropped frame.
    //   * The margin was 100ms, not wide. `DUCK_HOLD_MS` is 500 and the second read aimed at 400,
    //     and BOTH reads spend a `page.evaluate` CDP round-trip inside that budget. Measured: the
    //     second read landed at ~583ms of ticker time, so the hold had expired and the release had
    //     already started — `duck` read 0.515 (= 0.45 + 0.55 x 83/700) against a `< 0.5` bound.
    //     No amount of widening fixes this shape: the boundary is fixed at 500ms while the
    //     overhead ahead of it is unbounded.
    //
    // The timing itself is not this file's job, and it is not going untested — the envelope
    // (80ms attack, the hold still down at 400ms, full release) is pinned deterministically in
    // `test/audio/MusicPlayer.test.ts`'s "drops toward the duck level, holds, and comes all the
    // way back to 1", which drives `update()` with exact dt and cannot drift. What ONLY this file
    // can prove is the wiring: cue name -> `DUCK_CUES` membership -> `ContextAudioBus.play()` ->
    // `music.requestDuck()` -> a real `GainNode`. So it now asserts exactly that, two ways:
    //
    //   1. **Poll until the state arrives.** Both regressions this spec exists for — a bed that
    //      never ducks, and a duck that never releases — fail as a timeout here, which is a
    //      clearer report than an off-by-a-frame numeric bound ever was.
    //   2. **Assert the invariant `deckGain == steadyGain x duck` on ONE ATOMIC snapshot.** The
    //      `waitForFunction` handle carries the snapshot from the frame the condition held, so the
    //      gain and the duck it is being checked against cannot drift apart between two reads.
    //      Landing mid-ramp is now harmless: the invariant holds at every point on the ramp, while
    //      a duck that never reaches the graph breaks it at every point.

    /** Mirrors `DUCK_LEVEL` in MusicPlayer.ts. The NUMBER is pinned there and in MusicPlayer.test.ts; here it is only a floor to wait for. */
    const DUCK_LEVEL = 0.45;

    /**
     * The snapshot from the first frame on which the bed is at/below `floor` (`'ducked'`) or back
     * at exactly 1 (`'released'`).
     *
     * `polling: 'raf'` samples once per animation frame, i.e. on the same clock the envelope
     * advances on — so this cannot step over the state it is waiting for. The condition is
     * expressed as a mode + threshold rather than a callback because the page function is
     * serialized and can close over nothing (same constraint as the type-only casts in this
     * file's header).
     */
    const snapshotWhen = async (
      mode: 'ducked' | 'released',
      floor: number,
      what: string,
    ): Promise<MusicSnapshot> => {
      const handle = await page.waitForFunction(([m0, f]: [string, number]) => {
        const na = (window as unknown as { __nwAudio: { music(): MusicSnapshot | null } }).__nwAudio;
        const m = na.music();
        if (!m) return null;
        return (m0 === 'ducked' ? m.duck <= f : m.duck === 1) ? m : null;
      }, [mode, floor] as [string, number], { timeout: 10_000, polling: 'raf' })
        .catch((err: unknown) => { throw new Error(`timed out waiting for ${what}: ${String(err)}`); });
      return (await handle.jsonValue()) as MusicSnapshot;
    };

    // Attack: down to the duck floor. A cue that fell out of `DUCK_CUES`, or a `play()` that
    // stopped calling `requestDuck()`, never gets here.
    const ducked = await snapshotWhen('ducked', DUCK_LEVEL + 0.005, 'the bed to duck');
    expect(ducked.duck).toBeCloseTo(DUCK_LEVEL, 2);
    // The invariant, against the duck value from this same frame: the level reached the real graph.
    expect(maxDeckGain(ducked)).toBeCloseTo(steadyGain * ducked.duck, 3);

    // Release: all the way back to 1. A duck that sticks is a bed quietly 6.9 dB low forever, and
    // nothing else in the pipeline would report it.
    const released = await snapshotWhen('released', 1, 'the duck to release');
    expect(released.duck).toBe(1);
    expect(maxDeckGain(released)).toBeCloseTo(steadyGain, 3);

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
