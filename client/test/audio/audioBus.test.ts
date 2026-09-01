// The seam. Its whole job is that "nobody installed a device" is safe rather than a crash — which
// is the state every scene test, UI smoke and headless E2E in this repo runs in.
//
// Run with: npm test
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setAudioBus, audioBus, playSfx, NullAudioBus } from '../../src/audio/audioBus';
import type { AudioBus, AudioCue } from '../../src/audio/types';

/** Records what reached the device. */
function recorder(): AudioBus & { calls: [AudioCue, number | undefined][] } {
  const calls: [AudioCue, number | undefined][] = [];
  return {
    calls,
    async preload() {},
    play(cue, count) {
      calls.push([cue, count]);
    },
    setSfxVolume() {},
    setMusicVolume() {},
    updateMusic() {},
    resume() {},
  };
}

/**
 * A device whose `play` throws. Written out in full rather than spread over a NullAudioBus:
 * spreading a class instance copies no prototype methods, so that shape would be missing
 * `preload`/`resume`/the volume setters — which the compiler catches, and which would be a real
 * bug in anything but a test that only calls `play`.
 */
function brokenBus(): AudioBus {
  return {
    async preload() {},
    play() {
      throw new Error('device gone');
    },
    setSfxVolume() {},
    setMusicVolume() {},
    updateMusic() {},
    resume() {},
  };
}

// Module state outlives a single test, so every case restores the default.
afterEach(() => {
  setAudioBus(new NullAudioBus());
  vi.restoreAllMocks();
});

describe('audioBus seam', () => {
  it('defaults to a no-op device', async () => {
    // Not "throws a helpful error" — silence is the correct behaviour for a headless boot, and
    // making it loud would mean every widget test had to stub audio.
    const bus = audioBus();
    expect(bus).toBeInstanceOf(NullAudioBus);
    expect(() => bus.play('sfx.ui.tap')).not.toThrow();
    expect(() => bus.setSfxVolume(0.5)).not.toThrow();
    expect(() => bus.setMusicVolume(0.5)).not.toThrow();
    expect(() => bus.resume()).not.toThrow();
    await expect(bus.preload()).resolves.toBeUndefined();
  });

  it('routes to whatever the entry installed', () => {
    const rec = recorder();
    setAudioBus(rec);
    expect(audioBus()).toBe(rec);
    playSfx('sfx.card.play');
    playSfx('sfx.unit.hit', 7);
    expect(rec.calls).toEqual([
      ['sfx.card.play', 1],
      ['sfx.unit.hit', 7],
    ]);
  });

  it('playSfx passes count=1 by default, so the device never has to guess', () => {
    const rec = recorder();
    setAudioBus(rec);
    playSfx('sfx.ui.tap');
    expect(rec.calls[0][1]).toBe(1);
  });

  it('a throwing device cannot take down the caller', () => {
    // The call sites are inside render frames and button handlers: the player's action has already
    // happened, so a throw could only break whatever else that frame was going to do, in exchange
    // for a sound.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setAudioBus(brokenBus());
    expect(() => playSfx('sfx.ui.tap')).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns once per device, not once per press', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = brokenBus();
    setAudioBus(broken);
    for (let i = 0; i < 20; i++) playSfx('sfx.ui.tap');
    expect(warn).toHaveBeenCalledTimes(1);

    // Installing a device again re-arms the warning: a new device is a new failure worth hearing
    // about, and the alternative is that a genuine later regression stays invisible.
    setAudioBus(broken);
    playSfx('sfx.ui.tap');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('the warning names the cue that failed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setAudioBus(brokenBus());
    playSfx('sfx.result.victory');
    expect(String(warn.mock.calls[0][0])).toContain('sfx.result.victory');
  });
});

describe('NullAudioBus', () => {
  beforeEach(() => {
    setAudioBus(new NullAudioBus());
  });

  it('implements the whole AudioBus surface', () => {
    // A partial implementation would only surface as a TypeError at the one call site that uses
    // the missing method — on WeChat, where this is the shipped device.
    const bus: AudioBus = new NullAudioBus();
    for (const m of ['preload', 'play', 'setSfxVolume', 'setMusicVolume', 'resume'] as const) {
      expect(typeof bus[m], m).toBe('function');
    }
  });
});
