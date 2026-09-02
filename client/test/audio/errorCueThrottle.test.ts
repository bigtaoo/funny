// `sfx.ui.error` must not fan out. AUDIO_DESIGN.md §0.2 measured six parallel network failures
// producing six voices inside 23 ms and a bus peak of 0.3884 — 2.4x the loudest sound the game
// intends to make — while the player saw ONE toast (GlobalToast.show() calls clear() first).
//
// What is worth guarding here is only the arithmetic: N calls in a burst -> 1 cue. The reason the
// peak was 0.3884 rather than 0.078 lives in the AudioContext's summing and is invisible from node
// (that is the whole point of §0's "authored gain != delivered peak"), so no assertion here can see
// loudness. It can see the call count, which is the thing the fix changed.
//
// Run with: npm test
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setAudioBus, NullAudioBus } from '../../src/audio/audioBus';
import type { AudioBus, AudioCue } from '../../src/audio/types';
import { showToastMessage, setToastSink, __resetErrorCueThrottle } from '../../src/net/log';

function recorder(): AudioBus & { cues: AudioCue[] } {
  const cues: AudioCue[] = [];
  return {
    cues,
    async preload() {},
    play(cue) { cues.push(cue); },
    setSfxVolume() {},
    setMusicVolume() {},
    updateMusic() {},
    resume() {},
  };
}

describe('showToastMessage throttles the error cue', () => {
  let bus: ReturnType<typeof recorder>;
  let toasts: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    bus = recorder();
    setAudioBus(bus);
    toasts = [];
    setToastSink((text) => { toasts.push(text); });
    __resetErrorCueThrottle();
  });

  afterEach(() => {
    vi.useRealTimers();
    setAudioBus(new NullAudioBus());
  });

  it('collapses a same-instant fan-out to one cue', () => {
    // The shape measured in the browser: one underlying failure, six rejections, no time between.
    for (let i = 0; i < 6; i++) showToastMessage('network error ' + i, 'error');
    expect(bus.cues).toEqual(['sfx.ui.error']);
    // Every toast still shows — only the sound is merged. The visual layer's own coalescing
    // (show() -> clear()) is GlobalToast's business, not this function's.
    expect(toasts).toHaveLength(6);
  });

  it('still sounds for a failure outside the window', () => {
    showToastMessage('first', 'error');
    vi.advanceTimersByTime(399);
    showToastMessage('inside the window', 'error');
    expect(bus.cues).toHaveLength(1);
    vi.advanceTimersByTime(1);
    showToastMessage('outside the window', 'error');
    expect(bus.cues).toEqual(['sfx.ui.error', 'sfx.ui.error']);
  });

  it('does not let the throttle leak across a quiet gap', () => {
    // A leading-edge throttle must not accumulate: after any gap longer than the window the very
    // next failure sounds, however many were swallowed before it.
    for (let i = 0; i < 20; i++) showToastMessage('burst', 'error');
    vi.advanceTimersByTime(5000);
    showToastMessage('much later', 'error');
    expect(bus.cues).toHaveLength(2);
  });

  it('leaves success toasts silent, and they do not arm the throttle', () => {
    // Regression shape: if the throttle were armed by every toast rather than by every sounded
    // one, a "settings saved" success would silence the error that follows it.
    showToastMessage('saved', 'success');
    expect(bus.cues).toEqual([]);
    showToastMessage('but this failed', 'error');
    expect(bus.cues).toEqual(['sfx.ui.error']);
  });
});
