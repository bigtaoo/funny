// The scene → BGM map (AUDIO_DESIGN.md §2.3), plus the `playMusic` seam it is used through.
//
// `audioAssets.test.ts` already holds `SILENT_SCENES` to the class names that really exist in
// `src/scenes/` — a typo there is invisible at runtime. What is left for this file is the
// *policy*: that the map is default-ON, which is the whole reason a scene can never be silently
// forgotten (see the header of `sceneMusic.ts` for why that direction was chosen).
//
// Run with: npm test
import { describe, it, expect, afterEach, vi } from 'vitest';
import { musicForScene, SILENT_SCENES, DEFAULT_SCENE_TRACK } from '../../src/audio/sceneMusic';
import { setAudioBus, playMusic, NullAudioBus } from '../../src/audio/audioBus';
import type { AudioBus, MusicTrack } from '../../src/audio/types';

afterEach(() => {
  setAudioBus(new NullAudioBus());
  vi.restoreAllMocks();
});

function recorder(): AudioBus & { tracks: (MusicTrack | null)[] } {
  const tracks: (MusicTrack | null)[] = [];
  return {
    tracks,
    async preload() {},
    play() {},
    setSfxVolume() {},
    setMusicVolume() {},
    playMusic(track) { tracks.push(track); },
    resume() {},
  };
}

describe('musicForScene', () => {
  it('silences the match screens', () => {
    for (const name of SILENT_SCENES) expect(musicForScene(name)).toBeNull();
    expect(SILENT_SCENES).toContain('GameScene');
  });

  it('plays the lobby bed everywhere else', () => {
    for (const name of ['LobbyScene', 'ShopScene', 'WorldMapScene', 'ResultScene', 'IntroScene']) {
      expect(musicForScene(name), name).toBe(DEFAULT_SCENE_TRACK);
    }
  });

  it('a scene nobody registered still gets music — the direction the default points', () => {
    // This is the case the whole design turns on. A whitelist would answer `null` here, and a
    // silent screen is indistinguishable from a screen that is meant to be silent — the exact
    // failure mode §0 records the UI cue step hitting twice. Getting it wrong THIS way is
    // audible instead, which is the only kind of wrong anyone reports.
    expect(musicForScene('SomeSceneAddedNextMonth')).toBe(DEFAULT_SCENE_TRACK);
    // `SceneManager` falls back to this literal when a constructor has no name at all.
    expect(musicForScene('Scene')).toBe(DEFAULT_SCENE_TRACK);
  });
});

describe('playMusic seam', () => {
  it('forwards to the installed device', () => {
    const rec = recorder();
    setAudioBus(rec);
    playMusic('bgm.lobby');
    playMusic(null);
    expect(rec.tracks).toEqual(['bgm.lobby', null]);
  });

  it('swallows a throwing device and warns once — a scene change must not die for a bed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setAudioBus({
      async preload() {}, play() {}, setSfxVolume() {}, setMusicVolume() {}, resume() {},
      playMusic() { throw new Error('device gone'); },
    });
    expect(() => playMusic('bgm.lobby')).not.toThrow();
    expect(() => playMusic(null)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a fresh device gets a fresh warning budget', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken: AudioBus = {
      async preload() {}, play() {}, setSfxVolume() {}, setMusicVolume() {}, resume() {},
      playMusic() { throw new Error('device gone'); },
    };
    setAudioBus(broken);
    playMusic('bgm.lobby');
    setAudioBus(broken);
    playMusic('bgm.lobby');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('is safe with no device installed at all (every scene test runs in this state)', () => {
    expect(() => playMusic('bgm.lobby')).not.toThrow();
  });
});
