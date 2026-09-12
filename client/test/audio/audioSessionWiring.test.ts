// Player settings → the OS audio session, through the REAL bus (AUDIO_DESIGN.md §5 / §0.7).
//
// The 2026-09-11 fix ("opening the game stops the player's Spotify") has a platform-neutral half:
// never hold the audio session while making no sound. Two suites already cover its two ends, and
// **neither can see the middle**:
//
//   * `audioSettings.test.ts` installs a recording fake bus, so it proves `apply()` pushes `0` for
//     both channels — against an interface, not against anything that owns a session.
//   * `ContextAudioBus.test.ts` calls `setSfxVolume(0)`/`setMusicVolume(0)` directly, so it proves
//     a bus at 0/0 suspends — from a caller no player action ever takes.
//
// The chain between them is what the player actually does: mute, drag a slider to the bottom,
// watch an ad.
//
// **Measured honesty about what this buys** (2026-09-11, before committing it): it catches no
// mutation that nothing else catches. Both ends are densely covered, so the obvious breaks are
// already red elsewhere — clamping `apply()`'s silence to 0.0001 instead of 0 turns 4 of these red
// and 6 of `audioSettings.test.ts` + `crazyGamesPortalIsolation.test.ts` red as well. What it pins
// is the COMPOSITION, which is what those two structurally cannot: both ends can keep their own
// contracts while the chain between them stops existing — settings starts driving a different bus
// seam, or `ContextAudioBus` grows a `setMuted()` and settings switches to it, and every case in
// both suites stays green while the phone stays held. Same reason `audioDucking.spec.ts` exists,
// one layer down: cue → catalogue → graph there, setting → gain → session here.
//
// It also covers one combination nothing else does at all: an ad releasing and then restoring the
// session with the BGM decks in the loop.
//
// Run with: npm test
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ContextAudioBus } from '../../src/audio/ContextAudioBus';
import { setAudioBus, NullAudioBus } from '../../src/audio/audioBus';
import {
  installAudioSettings, resetAudioSettingsForTest,
  setAudioMuted, setAudioVolume, setAudioSuspended,
} from '../../src/audio/audioSettings';
import type { IStorage } from '../../src/platform/IPlatform';
import type { MusicDeck } from '../../src/audio/MusicPlayer';
import { fakeAudioContext, asCtx, type FakeAudioContext } from './fakeAudioContext';

function memStorage(): IStorage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}

class StubDeck implements MusicDeck {
  played: string[] = [];
  stops = 0;
  private pos: number | null = null;
  play(path: string): void { this.played.push(path); this.pos = 0; }
  setGain(): void { /* the envelope has its own suite */ }
  stop(): void { this.stops++; this.pos = null; }
  position(): number | null { return this.pos; }
  setPaused(): void { /* focus has its own cases */ }
}

interface Harness {
  ctx: FakeAudioContext;
  decks: [StubDeck, StubDeck];
  /** Frames enough to carry a full 2s crossfade several times over. */
  settle(): void;
}

/** The real bus, the real settings module, one fake context — the whole chain except the host. */
function wired(): Harness {
  const ctx = fakeAudioContext();
  ctx.state = 'suspended'; // what a real host hands over before the first gesture
  const decks: [StubDeck, StubDeck] = [new StubDeck(), new StubDeck()];
  let gestureCb = (): void => {};
  const bus = new ContextAudioBus({
    createContext: () => asCtx(ctx),
    onGesture: (cb) => { gestureCb = cb; },
    createMusicDecks: () => decks,
  });
  setAudioBus(bus);
  installAudioSettings({ storage: memStorage() });
  // Past the autoplay gate with the default (audible) settings, bed running: the state every one
  // of these cases starts from, because a session can only be GIVEN BACK if it was taken first.
  gestureCb();
  bus.updateMusic('bgm.lobby', 16);
  expect(ctx.state).toBe('running');
  expect(decks.some((d) => d.played.length > 0)).toBe(true);
  return {
    ctx,
    decks,
    settle: () => { for (let i = 0; i < 300; i++) bus.updateMusic('bgm.lobby', 16); },
  };
}

let h: Harness;
beforeEach(() => { h = wired(); });
afterEach(() => { resetAudioSettingsForTest(); setAudioBus(new NullAudioBus()); });

describe('settings → audio session', () => {
  it('the mute button hands the session back, and unmuting takes it again', () => {
    setAudioMuted(true);
    expect(h.ctx.suspendCalls).toBe(1);
    expect(h.ctx.state).toBe('suspended');

    setAudioMuted(false);
    expect(h.ctx.state).toBe('running');
  });

  it('muting also releases the BGM stream, and the bed comes back on unmute', () => {
    // Two streams, two releases: suspending the context does nothing to an `<audio>` element, and
    // on iOS that element holds the session on its own. The second half is the one that would be
    // reported as a bug — "I turned the music back on and it never came back".
    setAudioMuted(true);
    h.settle();
    expect(h.decks.some((d) => d.stops > 0)).toBe(true);
    const playsWhileMuted = h.decks.reduce((n, d) => n + d.played.length, 0);

    setAudioMuted(false);
    h.settle();
    expect(h.decks.reduce((n, d) => n + d.played.length, 0)).toBeGreaterThan(playsWhileMuted);
  });

  it('dragging master to the bottom releases it too — the trigger is the gain, not a flag', () => {
    // `muted` is one of three ways to reach silence (master 0, or both channels 0 are the others),
    // and the session logic deliberately keys off the effective gains `apply()` computes. A future
    // "if (muted) release()" shortcut would pass the case above and fail this one.
    setAudioVolume('master', 0);
    expect(h.ctx.state).toBe('suspended');

    setAudioVolume('master', 1);
    expect(h.ctx.state).toBe('running');
  });

  it('silencing one channel is not silence — the other still needs the session', () => {
    setAudioVolume('bgm', 0);
    expect(h.ctx.state).toBe('running');
    setAudioVolume('sfx', 0);
    expect(h.ctx.state).toBe('suspended');
  });

  it('an ad releases the session and the game gets it back afterwards', () => {
    // `setAudioSuspended` is the CrazyGames ad path (AUDIO_DESIGN.md §4). Handing the session back
    // for the duration is right — we are silent by portal requirement anyway — but the restore is
    // the half that matters: a session not retaken is a game that is silent for the rest of the
    // session, which is exactly the failure that flag's own design notes are built around.
    setAudioSuspended(true);
    expect(h.ctx.state).toBe('suspended');

    setAudioSuspended(false);
    expect(h.ctx.state).toBe('running');
    h.settle();
    expect(h.decks.some((d) => d.played.length > 0)).toBe(true);
  });

  it('an ad that ends on a player who had muted stays released', () => {
    // The two flags are independent by design (`suspended` must not overwrite the player's own
    // mute), so unsuspending into a muted game must not take the session back.
    setAudioMuted(true);
    setAudioSuspended(true);
    setAudioSuspended(false);
    expect(h.ctx.state).toBe('suspended');
  });
});
