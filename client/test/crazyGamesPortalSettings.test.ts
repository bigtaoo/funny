/**
 * CrazyGames portal obligations beyond Basic Launch's ad/loading ones (design/game/CRAZYGAMES_LAUNCH.md §2):
 *  * `game.settings.muteAudio` silences the game, outranks the in-game controls, and is followed live;
 *    it shares the host-suspend switch with ads, so neither may lift the other's silence;
 *  * a shared replay link points at the game's portal page (`inviteLink`), not at the iframe's own URL;
 *  * safe-area insets are read (CrazyGames App runs edge to edge).
 *
 * The SDK double mirrors https://sdk.crazygames.com/crazygames-sdk-v3.js: `settings` is a plain
 * `{ muteAudio, disableChat }` object on `game`, changes arrive through `addSettingsChangeListener`
 * callbacks with the whole settings object, and `inviteLink(params)` returns the URL synchronously.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AudioBus, AudioCue, MusicTrack } from '../src/audio/types';

class RecordingBus implements AudioBus {
  sfx: number[] = [];
  music: number[] = [];
  async preload(): Promise<void> {}
  play(_cue: AudioCue, _count?: number): void {}
  setSfxVolume(v: number): void { this.sfx.push(v); }
  setMusicVolume(v: number): void { this.music.push(v); }
  updateMusic(_desired: MusicTrack | null, _dtMs: number): void {}
  resume(): void {}
}

type Settings = { muteAudio: boolean; disableChat: boolean };
type AdCbs = { adStarted?(): void; adFinished?(): void; adError?(e: unknown): void };

function fakeSdk(initialMute: boolean) {
  const listeners: Array<(s: Settings) => void> = [];
  const settings: Settings = { muteAudio: initialMute, disableChat: false };
  let adCbs: AdCbs = {};
  const sdk = {
    init: () => Promise.resolve(),
    game: {
      gameplayStart: () => {}, gameplayStop: () => {},
      loadingStart: () => {}, loadingStop: () => {},
      settings,
      addSettingsChangeListener: (cb: (s: Settings) => void) => { listeners.push(cb); },
      inviteLink: (params: Record<string, string>) =>
        `https://www.crazygames.com/game/notebook-wars?${new URLSearchParams(params).toString()}`,
    },
    ad: {
      requestAd: (_t: string, c: AdCbs) => { adCbs = c; },
      prefetchAd: () => {},
      hasAdblock: () => Promise.resolve(false),
    },
    user: { systemInfo: {}, getUserToken: () => Promise.reject(new Error('userNotAuthenticated')) },
  };
  /** What the SDK does on the portal's `audioChanged` message. */
  const portalSetsMute = (v: boolean): void => {
    settings.muteAudio = v;
    listeners.forEach((l) => l(settings));
  };
  return { sdk, portalSetsMute, ad: () => adCbs };
}

function stubDom(sdk?: unknown, clipboard?: string[]): void {
  const fakeCanvas = { id: '', style: {} } as unknown as HTMLCanvasElement;
  vi.stubGlobal('document', {
    getElementById: () => null,
    createElement: () => fakeCanvas,
    body: { appendChild: () => {}, style: {} },
  });
  vi.stubGlobal('window', {
    devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720,
    location: { origin: 'https://games.crazygames.com', pathname: '/en_US/notebook-wars/index.html', search: '' },
    ...(sdk ? { CrazyGames: { SDK: sdk } } : {}),
  });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('navigator', {
    language: 'en',
    clipboard: { writeText: (t: string) => { clipboard?.push(t); return Promise.resolve(); } },
  });
}

async function boot(initialMute = false) {
  const fake = fakeSdk(initialMute);
  stubDom(fake.sdk);
  const audio = await import('../src/audio/audioSettings');
  const { setAudioBus } = await import('../src/audio/audioBus');
  const bus = new RecordingBus();
  setAudioBus(bus);
  audio.installAudioSettings({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  const { CrazyGamesPlatform } = await import('../src/platform/crazygames/CrazyGamesPlatform');
  const platform = new CrazyGamesPlatform();
  await platform.onLoadingComplete();
  return { platform, bus, audio, ...fake };
}

const silent = (bus: RecordingBus): boolean =>
  bus.sfx[bus.sfx.length - 1] === 0 && bus.music[bus.music.length - 1] === 0;

describe('CrazyGamesPlatform — portal mute setting', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(async () => {
    const { resetAudioSettingsForTest } = await import('../src/audio/audioSettings');
    resetAudioSettingsForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('starts silent when the portal is already muted at launch', async () => {
    const { bus } = await boot(true);
    expect(silent(bus)).toBe(true);
  });

  it('follows the portal toggling mute while the game runs', async () => {
    const { bus, portalSetsMute } = await boot(false);
    expect(silent(bus)).toBe(false);
    portalSetsMute(true);
    expect(silent(bus)).toBe(true);
    portalSetsMute(false);
    expect(silent(bus)).toBe(false);
  });

  it('never persists and never overwrites the player\'s own mute', async () => {
    const { bus, audio, portalSetsMute } = await boot(false);
    portalSetsMute(true);
    expect(audio.getAudioSettings().muted).toBe(false);
    audio.setAudioMuted(true);
    portalSetsMute(false);
    expect(audio.getAudioSettings().muted).toBe(true);
    expect(silent(bus)).toBe(true);
  });

  it('REGRESSION: an ad finishing does not unmute a muted portal', async () => {
    const { platform, bus, ad } = await boot(true);
    const p = platform.showMidgameAd();
    ad().adStarted?.();
    ad().adFinished?.();
    await p;
    expect(silent(bus)).toBe(true);
  });

  it('the portal unmuting mid-ad does not bring audio back over the ad', async () => {
    const { platform, bus, ad, portalSetsMute } = await boot(true);
    const p = platform.showMidgameAd();
    ad().adStarted?.();
    portalSetsMute(false);
    expect(silent(bus)).toBe(true);
    ad().adFinished?.();
    await p;
    expect(silent(bus)).toBe(false);
  });
});

describe('CrazyGamesPlatform — replay share link', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('REGRESSION: on the portal the link is the portal game page (inviteLink), not the iframe URL', async () => {
    const fake = fakeSdk(false);
    const copied: string[] = [];
    stubDom(fake.sdk, copied);
    const { CrazyGamesPlatform } = await import('../src/platform/crazygames/CrazyGamesPlatform');
    const res = await new CrazyGamesPlatform().shareReplay('abc123', 'Replay');
    expect(res.url).toBe('https://www.crazygames.com/game/notebook-wars?r=abc123');
    expect(copied).toEqual([res.url]);
    expect(res.url).not.toContain('games.crazygames.com');
  });

  it('off the portal (no SDK) falls back to the page URL', async () => {
    stubDom(undefined, []);
    const { CrazyGamesPlatform } = await import('../src/platform/crazygames/CrazyGamesPlatform');
    const res = await new CrazyGamesPlatform().shareReplay('abc123', 'Replay');
    expect(res.url).toBe('https://games.crazygames.com/en_US/notebook-wars/index.html?r=abc123');
  });
});

describe('CrazyGamesPlatform — safe area', () => {
  it('implements both safe-area hooks (CrazyGames App runs edge to edge)', async () => {
    const { CrazyGamesPlatform } = await import('../src/platform/crazygames/CrazyGamesPlatform');
    expect(typeof CrazyGamesPlatform.prototype.getSafeAreaInsets).toBe('function');
    expect(typeof CrazyGamesPlatform.prototype.onSafeAreaInsetsChanged).toBe('function');
  });
});
