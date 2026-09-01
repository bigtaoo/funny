// The BGM player (AUDIO_DESIGN.md §2.3 / §7 step 7).
//
// Same premise as `ContextAudioBus.test.ts`: audio fails SILENTLY, so "it didn't throw" proves
// nothing. Every case below asserts on what the fake `MusicSource` was actually told — which url,
// how many times, at what volume — because those are the four ways a music bug shows up:
// the wrong track, a restart the player should have suppressed, a level that drifted, and a
// stream nobody ever resumed after the autoplay gate rejected it.
//
// The fades run on real `setInterval`, so the clock is faked. That is deliberate: a fade driven
// by an injected ticker would be easier to test and strictly less honest — `MusicPlayer` owning
// its own timer is exactly the thing that has to keep working when nothing calls it.
//
// Run with: npm test
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MusicPlayer, FADE_IN_MS, FADE_OUT_MS, FADE_STEP_MS, type MusicSource,
} from '../../src/audio/MusicPlayer';
import { MUSIC_TRACKS } from '../../src/audio/musicTracks';

const LOBBY = MUSIC_TRACKS['bgm.lobby'];

interface FakeSource extends MusicSource {
  loads: { url: string; loop: boolean }[];
  plays: number;
  pauses: number;
  volume: number;
  volumes: number[];
  playing: boolean;
  /** Model the autoplay gate: `play()` is accepted but the stream does not actually start. */
  blocked: boolean;
}

function fakeSource(): FakeSource {
  return {
    loads: [],
    plays: 0,
    pauses: 0,
    volume: 0,
    volumes: [],
    playing: false,
    blocked: false,
    load(url, loop) { this.loads.push({ url, loop }); },
    play() { this.plays++; if (!this.blocked) this.playing = true; },
    pause() { this.pauses++; this.playing = false; },
    setVolume(v) { this.volume = v; this.volumes.push(v); },
    isPlaying() { return this.playing; },
  };
}

describe('MusicPlayer', () => {
  let src: FakeSource;
  let player: MusicPlayer;

  beforeEach(() => {
    vi.useFakeTimers();
    src = fakeSource();
    player = new MusicPlayer(src);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts silent — constructing it must not touch the stream', () => {
    // The player is built at boot, long before any scene exists. If it loaded or played here,
    // every headless run would fetch 2 MB of music.
    expect(src.loads).toEqual([]);
    expect(src.plays).toBe(0);
  });

  it('loads the track once and fades in from silence', () => {
    player.setTrack('bgm.lobby');
    expect(src.loads).toEqual([{ url: LOBBY.url, loop: true }]);
    expect(src.plays).toBe(1);
    // The FIRST volume written must be 0, not the target: a bed that starts at full level and
    // then ramps is not a fade-in, it is a pop followed by a fade-in.
    expect(src.volumes[0]).toBe(0);

    vi.advanceTimersByTime(FADE_IN_MS / 2);
    expect(src.volume).toBeGreaterThan(0);
    expect(src.volume).toBeLessThan(LOBBY.gain);

    vi.advanceTimersByTime(FADE_IN_MS);
    // Channel defaults to 1 here (the bus pushes the real 0.5 in); level 1 x channel 1 x gain.
    expect(src.volume).toBeCloseTo(LOBBY.gain, 6);
    expect(player.state).toMatchObject({ want: 'bgm.lobby', loaded: 'bgm.lobby', level: 1, paused: false });
  });

  it('stops its own timer once the fade settles (a 20 Hz idle timer runs for the whole session)', () => {
    player.setTrack('bgm.lobby');
    vi.advanceTimersByTime(FADE_IN_MS + FADE_STEP_MS);
    const writes = src.volumes.length;
    vi.advanceTimersByTime(10_000);
    expect(src.volumes.length).toBe(writes);
  });

  it('asking for the track already playing changes nothing — lobby→shop→lobby must not restart it', () => {
    player.setTrack('bgm.lobby');
    vi.advanceTimersByTime(FADE_IN_MS);
    player.setTrack('bgm.lobby');
    player.setTrack('bgm.lobby');
    expect(src.loads).toHaveLength(1);
    expect(src.plays).toBe(1);
  });

  it('fades out to silence on null and pauses — without unloading', () => {
    player.setTrack('bgm.lobby');
    vi.advanceTimersByTime(FADE_IN_MS);
    player.setTrack(null);

    vi.advanceTimersByTime(FADE_OUT_MS / 2);
    expect(src.volume).toBeGreaterThan(0);
    expect(src.pauses).toBe(0);

    vi.advanceTimersByTime(FADE_OUT_MS);
    expect(src.volume).toBe(0);
    expect(src.pauses).toBe(1);
    // Still loaded: coming back from a match resumes where the bed was, instead of re-buffering
    // 2 MB and restarting the phrase.
    expect(player.state).toMatchObject({ want: null, loaded: 'bgm.lobby', level: 0, paused: true });
  });

  it('fades out faster than it fades in (leaving makes way, arriving settles in)', () => {
    expect(FADE_OUT_MS).toBeLessThan(FADE_IN_MS);
  });

  it('a request arriving mid-fade-out reverses it instead of restarting the track', () => {
    player.setTrack('bgm.lobby');
    vi.advanceTimersByTime(FADE_IN_MS);
    player.setTrack(null);
    vi.advanceTimersByTime(FADE_OUT_MS / 3);
    const mid = src.volume;
    expect(mid).toBeGreaterThan(0);

    player.setTrack('bgm.lobby');
    vi.advanceTimersByTime(FADE_IN_MS);
    expect(src.volume).toBeCloseTo(LOBBY.gain, 6);
    // One load, one play — the reversal never went through the stream at all.
    expect(src.loads).toHaveLength(1);
  });

  it('resumes from a settled pause without reloading', () => {
    player.setTrack('bgm.lobby');
    vi.advanceTimersByTime(FADE_IN_MS);
    player.setTrack(null);
    vi.advanceTimersByTime(FADE_OUT_MS + FADE_STEP_MS);
    expect(src.pauses).toBe(1);

    player.setTrack('bgm.lobby');
    vi.advanceTimersByTime(FADE_IN_MS);
    expect(src.loads).toHaveLength(1);
    expect(src.plays).toBe(2);
    expect(src.volume).toBeCloseTo(LOBBY.gain, 6);
  });

  it('applies the channel volume through the track gain — the delivered-peak arithmetic', () => {
    // The number `musicTracks.ts` argues for: at the shipped defaults (master 1 x bgm 0.5) the
    // element volume is 0.1, so the delivered peak is 0.1 x the file's 0.6911 = 0.069.
    player.setChannelVolume(0.5);
    player.setTrack('bgm.lobby');
    vi.advanceTimersByTime(FADE_IN_MS);
    expect(src.volume).toBeCloseTo(0.5 * LOBBY.gain, 6);
    expect(src.volume).toBeCloseTo(0.1, 6);
  });

  it('a channel change lands immediately, mid-fade included', () => {
    player.setTrack('bgm.lobby');
    vi.advanceTimersByTime(FADE_IN_MS);
    player.setChannelVolume(0.25);
    expect(src.volume).toBeCloseTo(0.25 * LOBBY.gain, 6);
    player.setChannelVolume(2);      // clamped, not trusted
    expect(src.volume).toBeCloseTo(LOBBY.gain, 6);
  });

  it('muting silences without stopping — unmuting must not restart the track', () => {
    player.setTrack('bgm.lobby');
    vi.advanceTimersByTime(FADE_IN_MS);
    player.setChannelVolume(0);      // this is what `muted` pushes down
    expect(src.volume).toBe(0);
    expect(src.pauses).toBe(0);
    player.setChannelVolume(0.5);
    expect(src.volume).toBeCloseTo(0.5 * LOBBY.gain, 6);
    expect(src.plays).toBe(1);
  });

  it('backgrounding pauses immediately (no fade) and foregrounding resumes', () => {
    player.setTrack('bgm.lobby');
    vi.advanceTimersByTime(FADE_IN_MS);
    player.setHidden(true);
    expect(src.pauses).toBe(1);
    expect(player.state.level).toBe(1);   // the fade state is untouched — it is a pause, not a stop
    player.setHidden(false);
    expect(src.plays).toBe(2);
  });

  it('a hidden page does not get played by a scene change underneath it', () => {
    // A pushed match landing while the phone is locked would otherwise start the stream in the
    // background — audible the moment the player unlocks, before any scene has been looked at.
    player.setHidden(true);
    player.setTrack('bgm.lobby');
    expect(src.plays).toBe(0);
    player.setHidden(false);
    expect(src.plays).toBe(1);
  });

  it('holds the fade at 0 while the autoplay gate is shut, then fades in on the gesture', () => {
    // Measured in Chrome before this was fixed (AUDIO_DESIGN §0.5): 6 s after boot the player
    // reported level 0.67 while `element.paused` was still true. The fade had quietly run most of
    // its course with nothing audible following it, so the first tap would have brought the bed in
    // at near-full level — a pop, which is the one thing a fade-in exists to prevent.
    src.blocked = true;
    player.setTrack('bgm.lobby');
    vi.advanceTimersByTime(FADE_IN_MS * 3);
    expect(player.state.level).toBe(0);
    expect(src.volume).toBe(0);

    src.blocked = false;
    player.resume();
    vi.advanceTimersByTime(FADE_IN_MS / 2);
    expect(src.volume).toBeGreaterThan(0);
    expect(src.volume).toBeLessThan(LOBBY.gain);
    vi.advanceTimersByTime(FADE_IN_MS);
    expect(src.volume).toBeCloseTo(LOBBY.gain, 6);
  });

  it('does not burn a 20 Hz timer for the whole pre-gesture window', () => {
    src.blocked = true;
    player.setTrack('bgm.lobby');
    vi.advanceTimersByTime(FADE_STEP_MS * 2);
    const writes = src.volumes.length;
    vi.advanceTimersByTime(60_000);
    expect(src.volumes.length).toBe(writes);
  });

  it('a backgrounded page freezes the fade instead of running it out unheard', () => {
    player.setHidden(true);
    player.setTrack('bgm.lobby');
    vi.advanceTimersByTime(FADE_IN_MS * 2);
    expect(player.state.level).toBe(0);
    player.setHidden(false);
    vi.advanceTimersByTime(FADE_IN_MS);
    expect(src.volume).toBeCloseTo(LOBBY.gain, 6);
  });

  it('retries play() on resume() — the only cure for an autoplay rejection', () => {
    // The first request for lobby music happens before the player has ever touched the screen,
    // so `HTMLAudioElement.play()` is rejected. Nothing else in the system ever tries again.
    player.setTrack('bgm.lobby');
    expect(src.plays).toBe(1);
    player.resume();
    expect(src.plays).toBe(2);
  });

  it('resume() does nothing when no track is wanted', () => {
    player.resume();
    expect(src.plays).toBe(0);
    player.setTrack('bgm.lobby');
    player.setTrack(null);
    vi.advanceTimersByTime(FADE_OUT_MS + FADE_STEP_MS);
    const plays = src.plays;
    player.resume();
    expect(src.plays).toBe(plays);
  });

  it('stop() cuts immediately, without a fade', () => {
    player.setTrack('bgm.lobby');
    vi.advanceTimersByTime(FADE_IN_MS);
    player.stop();
    expect(src.volume).toBe(0);
    expect(src.pauses).toBe(1);
    expect(player.state).toMatchObject({ want: null, level: 0, paused: true });
    vi.advanceTimersByTime(10_000);
    expect(src.pauses).toBe(1);          // and the timer really is gone
  });
});
