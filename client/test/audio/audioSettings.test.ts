// Volume/mute persistence and how it reaches the bus (AUDIO_DESIGN.md §4).
//
// Run with: npm test
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IStorage } from '../../src/platform/IPlatform';
import { setAudioBus, NullAudioBus } from '../../src/audio/audioBus';
import type { AudioBus } from '../../src/audio/types';
import {
  AUDIO_SETTINGS_KEY, DEFAULT_AUDIO_SETTINGS,
  installAudioSettings, resetAudioSettingsForTest,
  getAudioSettings, setAudioVolume, setAudioMuted,
} from '../../src/audio/audioSettings';

function memStorage(seed?: Record<string, string>): IStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed ?? {}));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

/** A bus that only records the gains, which is the whole observable effect of this module. */
function gainBus(): AudioBus & { sfx: number[]; music: number[] } {
  const sfx: number[] = [];
  const music: number[] = [];
  return {
    sfx, music,
    async preload() {},
    play() {},
    setSfxVolume(v) { sfx.push(v); },
    setMusicVolume(v) { music.push(v); },
    resume() {},
  };
}

let bus: ReturnType<typeof gainBus>;
beforeEach(() => { bus = gainBus(); setAudioBus(bus); });
afterEach(() => { resetAudioSettingsForTest(); setAudioBus(new NullAudioBus()); });

const last = (a: number[]): number => a[a.length - 1]!;

describe('installAudioSettings', () => {
  it('with nothing stored, applies the documented defaults', () => {
    installAudioSettings({ storage: memStorage() });
    expect(getAudioSettings()).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(last(bus.sfx)).toBeCloseTo(0.8);   // master 1 × sfx 0.8
    expect(last(bus.music)).toBeCloseTo(0.5); // master 1 × bgm 0.5
  });

  it('restores a saved blob and applies master × channel', () => {
    const store = memStorage({ [AUDIO_SETTINGS_KEY]: JSON.stringify({ master: 0.5, bgm: 0.4, sfx: 1, muted: false }) });
    installAudioSettings({ storage: store });
    expect(getAudioSettings().master).toBe(0.5);
    expect(last(bus.sfx)).toBeCloseTo(0.5);
    expect(last(bus.music)).toBeCloseTo(0.2);
  });

  it('a corrupt or partial blob degrades per field, never to silence', () => {
    installAudioSettings({ storage: memStorage({ [AUDIO_SETTINGS_KEY]: '{not json' }) });
    expect(getAudioSettings()).toEqual(DEFAULT_AUDIO_SETTINGS);

    resetAudioSettingsForTest();
    installAudioSettings({ storage: memStorage({ [AUDIO_SETTINGS_KEY]: JSON.stringify({ sfx: 0.25 }) }) });
    expect(getAudioSettings()).toEqual({ ...DEFAULT_AUDIO_SETTINGS, sfx: 0.25 });
  });

  it('clamps out-of-range stored values instead of trusting them', () => {
    installAudioSettings({ storage: memStorage({ [AUDIO_SETTINGS_KEY]: JSON.stringify({ master: 4, sfx: -2, bgm: NaN }) }) });
    const s = getAudioSettings();
    expect(s.master).toBe(1);
    expect(s.sfx).toBe(0);
    expect(s.bgm).toBe(DEFAULT_AUDIO_SETTINGS.bgm); // NaN is not a usable number → default
  });
});

describe('setAudioVolume / setAudioMuted', () => {
  it('persists under the one key and re-applies both channels', () => {
    const store = memStorage();
    installAudioSettings({ storage: store });
    setAudioVolume('sfx', 0.25);
    expect(getAudioSettings().sfx).toBe(0.25);
    expect(last(bus.sfx)).toBeCloseTo(0.25);
    expect(JSON.parse(store.data.get(AUDIO_SETTINGS_KEY)!)).toEqual({ ...DEFAULT_AUDIO_SETTINGS, sfx: 0.25 });
  });

  it('clamps the slider input — a drag runs past both ends of the track', () => {
    installAudioSettings({ storage: memStorage() });
    setAudioVolume('master', 1.8);
    expect(getAudioSettings().master).toBe(1);
    setAudioVolume('master', -0.4);
    expect(getAudioSettings().master).toBe(0);
  });

  it('mute zeroes both buses WITHOUT touching the sliders, so unmute restores the level', () => {
    installAudioSettings({ storage: memStorage() });
    setAudioVolume('sfx', 0.6);
    setAudioMuted(true);
    expect(last(bus.sfx)).toBe(0);
    expect(last(bus.music)).toBe(0);
    expect(getAudioSettings().sfx).toBe(0.6);

    setAudioMuted(false);
    expect(last(bus.sfx)).toBeCloseTo(0.6);
  });

  it('survives a relaunch — a fresh install reads back what was set', () => {
    const store = memStorage();
    installAudioSettings({ storage: store });
    setAudioVolume('bgm', 0.1);
    setAudioMuted(true);
    resetAudioSettingsForTest();
    installAudioSettings({ storage: store });
    expect(getAudioSettings()).toEqual({ ...DEFAULT_AUDIO_SETTINGS, bgm: 0.1, muted: true });
  });

  it('a storage that throws on write must not break the settings screen', () => {
    const store: IStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => {},
    };
    installAudioSettings({ storage: store });
    expect(() => setAudioVolume('sfx', 0.3)).not.toThrow();
    expect(getAudioSettings().sfx).toBe(0.3); // in-memory value still took effect this session
  });
});

describe('uninstalled (unit tests, headless harness)', () => {
  it('reads the defaults and drops writes without throwing', () => {
    expect(getAudioSettings()).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(() => setAudioMuted(true)).not.toThrow();
  });
});
