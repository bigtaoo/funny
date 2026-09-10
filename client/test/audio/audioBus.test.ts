// The seam. Its whole job is that "nobody installed a device" is safe rather than a crash — which
// is the state every scene test, UI smoke and headless E2E in this repo runs in.
//
// Run with: npm test
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setAudioBus, audioBus, playSfx, updateMusic, NullAudioBus } from '../../src/audio/audioBus';
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

// The BGM half of the same seam (2026-09-10). It was written to the shape of playSfx above and
// then left with zero cases — an FNDA sweep found `updateMusic` (and NullAudioBus's own
// `updateMusic`) at zero hits while every playSfx branch here was pinned. The asymmetry is the
// wrong way round: this one runs on `app.ticker`, AHEAD of PIXI's renderer listener, and PIXI 7
// aborts the update loop and schedules no further rAF when a ticker listener throws — i.e. a
// throw that escapes here freezes the whole canvas until the player reloads, where the worst
// playSfx can do is lose one sound.
describe('updateMusic seam', () => {
  /** A device whose `updateMusic` throws (written out in full for the same reason as brokenBus). */
  function brokenMusicBus(): AudioBus {
    return {
      async preload() {},
      play() {},
      setSfxVolume() {},
      setMusicVolume() {},
      updateMusic() {
        throw new Error('deck gone');
      },
      resume() {},
    };
  }

  it('forwards the desired track and the frame delta to the installed device', () => {
    const calls: [string | null, number][] = [];
    const rec = recorder();
    rec.updateMusic = (desired, dtMs) => { calls.push([desired, dtMs]); };
    setAudioBus(rec);

    updateMusic('bgm.lobby', 16);
    updateMusic(null, 33);

    // Both arguments matter: dropping dtMs would stall every fade at its first frame (the decks
    // advance their cross-fade purely from this number), and it would still look like it works.
    expect(calls).toEqual([['bgm.lobby', 16], [null, 33]]);
  });

  it('a throwing device cannot take down the ticker', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setAudioBus(brokenMusicBus());
    expect(() => updateMusic('bgm.lobby', 16)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns once per device, not sixty times a second', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = brokenMusicBus();
    setAudioBus(broken);
    for (let i = 0; i < 120; i++) updateMusic('bgm.lobby', 16); // two seconds of a broken deck
    expect(warn).toHaveBeenCalledTimes(1);

    // Re-installing re-arms it, same as the cue side.
    setAudioBus(broken);
    updateMusic('bgm.lobby', 16);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('keeps its own throttle: a broken deck does not consume the cue warning', () => {
    // The two `warned` flags are separate module state. Sharing one would mean a deck that fails
    // on frame 1 silences the FIRST genuine cue failure of the session — the one worth hearing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setAudioBus({ ...brokenMusicBus(), play() { throw new Error('device gone'); } });

    updateMusic('bgm.lobby', 16);
    playSfx('sfx.ui.tap');

    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain('BGM');
    expect(String(warn.mock.calls[1][0])).toContain('sfx.ui.tap');
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
    // `updateMusic` was missing from this list until 2026-09-10, which is exactly how
    // NullAudioBus.updateMusic reached an FNDA of zero: the surface check that was supposed to
    // cover the whole interface had a hole in the shape of the newest method on it.
    for (const m of ['preload', 'play', 'setSfxVolume', 'setMusicVolume', 'updateMusic', 'resume'] as const) {
      expect(typeof bus[m], m).toBe('function');
    }
  });

  it('does nothing, loudly enough: every method is safe to call on it', () => {
    const bus: AudioBus = new NullAudioBus();
    expect(() => bus.updateMusic('bgm.lobby', 16)).not.toThrow();
    expect(() => bus.updateMusic(null, 0)).not.toThrow();
  });
});
