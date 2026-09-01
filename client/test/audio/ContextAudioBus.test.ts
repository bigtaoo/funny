// The backend half of the audio layer — everything that happens once a host has handed over a
// Web Audio context. Extracted from `platform/web/WebAudioBus.ts` on 2026-08-31 when the WeChat
// backend landed and made it obvious the class was 90% platform-neutral (AUDIO_DESIGN.md §3).
//
// **It had no tests at all before that extraction**, because `platform/**` is outside the
// coverage gate's include list while `src/audio/**` is inside it. So these cases are not a
// port — they are the first ones this behaviour has ever had, and they now cover BOTH platforms
// at once: `WebAudioBus` and `WechatAudioBus` are each ~15 lines answering two questions.
//
// What matters here is the failure mode: audio fails SILENTLY. "It didn't throw" is equally true
// of a bus that builds nothing, so every case below asserts on the node graph the fake context
// recorded, not on the absence of an exception.
//
// Run with: npm test
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ContextAudioBus, DEFAULT_SFX_VOLUME, DEFAULT_MUSIC_VOLUME } from '../../src/audio/ContextAudioBus';
import { FADE_IN_MS } from '../../src/audio/MusicPlayer';
import { MUSIC_TRACKS } from '../../src/audio/musicTracks';
import { setAssetIO } from '../../src/assets/assetIO';
import { allSfxUrls } from '../../src/audio/cueAssets';
import { fakeAudioContext, asCtx, type FakeAudioContext } from './fakeAudioContext';

// The bus reads bytes through the module-level `assetIO()` seam, not through its own deps (see
// ContextAudioBus's comment on why: an entry point may `setAssetIO` after the bus is built). The
// default is `WebAssetIO`, i.e. `fetch` — which under node has no base URL, so every `preload()`
// below used to emit a stack trace per asset. It was harmless (the SampleBank is per-file
// best-effort and each variant falls back to the synth voice) and invisible while `cueAssets.ts`
// was empty; the moment 22 real files landed it became 22 stack traces per run, which is how
// people stop reading test output.
//
// So the network is stubbed out here, and the per-file warnings are collected instead of printed
// via the `warn` dep — both are the seams the production code already has, not test-only escapes.
beforeEach(() => {
  setAssetIO({
    loadBinary: () => Promise.reject(new Error('no assets in unit tests')),
    textureSource: (url: string) => Promise.resolve(url),
  });
});

/** A stand-in for the platform's streaming music player (see `MusicSource`). */
function fakeMusicSource() {
  return {
    loads: [] as { url: string; loop: boolean }[],
    plays: 0,
    pauses: 0,
    volume: 0,
    load(url: string, loop: boolean) { this.loads.push({ url, loop }); },
    play() { this.plays++; },
    pause() { this.pauses++; },
    setVolume(v: number) { this.volume = v; },
  };
}

/** A bus over a fresh fake context, plus the handles a case needs to poke at it. */
function bus(opts: { state?: 'suspended' | 'running'; music?: 'ok' | 'absent' | 'throws' } = {}) {
  const ctx = fakeAudioContext();
  ctx.state = opts.state ?? 'running';
  let creates = 0;
  const gestures: (() => void)[] = [];
  const visibility: ((visible: boolean) => void)[] = [];
  const warnings: string[] = [];
  const src = fakeMusicSource();
  const b = new ContextAudioBus({
    createContext: () => {
      creates++;
      return asCtx(ctx);
    },
    onGesture: (cb) => gestures.push(cb),
    warn: (message) => warnings.push(message),
    createMusicSource: () => {
      if (opts.music === 'absent') return null;
      if (opts.music === 'throws') throw new Error('no music device');
      return src;
    },
    onVisibility: (cb) => visibility.push(cb),
  });
  return {
    b,
    ctx,
    gestures,
    visibility,
    warnings,
    music: src,
    creates: () => creates,
    /** The SFX bus node: the first gain created, i.e. the one wired to `destination`. */
    busNode: () => ctx.of('gain').find((g) => g.out.includes(ctx.destination)),
  };
}

describe('ContextAudioBus — building the bus', () => {
  it('does not touch the host until something actually needs audio', () => {
    // Constructing the device happens at entry-point import time, long before the player has
    // pressed anything. Creating an `AudioContext` there costs a real audio device on some hosts.
    const h = bus();
    expect(h.creates()).toBe(0);
    expect(h.ctx.nodes).toHaveLength(0);
  });

  it('wires exactly one gain node between the mixer and the destination', () => {
    const h = bus();
    void h.b.preload();
    const node = h.busNode();
    expect(node).toBeDefined();
    expect(node!.gain!.value).toBe(DEFAULT_SFX_VOLUME);
    expect(node!.out).toEqual([h.ctx.destination]);
  });

  it('builds the context once and reuses it across every entry point', () => {
    const h = bus();
    void h.b.preload();
    h.b.resume();
    h.b.play('sfx.ui.tap');
    h.b.setSfxVolume(0.5);
    expect(h.creates()).toBe(1);
    expect(h.ctx.of('gain').filter((g) => g.out.includes(h.ctx.destination))).toHaveLength(1);
  });
});

describe('ContextAudioBus — a host with no audio device', () => {
  // WeChat base library < 2.19.0 (no `wx.createWebAudioContext`), SSR, node, ancient WebViews.
  // AUDIO_DESIGN.md §3: there is deliberately no HTMLAudioElement fallback, so this path is
  // "this host is silent", and it has to be survivable at every call site.
  function silent(create: () => AudioContext | null) {
    let creates = 0;
    return {
      creates: () => creates,
      b: new ContextAudioBus({
        createContext: () => {
          creates++;
          return create();
        },
      }),
    };
  }

  it('stays silent instead of throwing when the host has no context at all', async () => {
    const h = silent(() => null);
    await expect(h.b.preload()).resolves.toBeUndefined();
    expect(() => {
      h.b.resume();
      h.b.play('sfx.card.play', 4);
      h.b.setSfxVolume(0.3);
      h.b.setMusicVolume(0.3);
    }).not.toThrow();
    expect(h.b.loaded).toEqual({ cues: 0, variants: 0 });
  });

  it('stays silent when the host claims the API but construction throws', () => {
    // The likeliest real shape of this: a base library that declares
    // `createWebAudioContext` and whose compatibility layer fails inside it.
    const h = silent(() => {
      throw new Error('base library lied');
    });
    expect(() => h.b.play('sfx.ui.tap')).not.toThrow();
  });

  it('gives up after one attempt rather than retrying on every frame', () => {
    // `play()` runs inside the render loop. A bus that retried construction per call would turn
    // one absent API into 60 throws a second — and the catch above would hide it perfectly.
    const h = silent(() => null);
    for (let i = 0; i < 5; i++) h.b.play('sfx.unit.hit');
    h.b.resume();
    void h.b.preload();
    expect(h.creates()).toBe(1);
  });
});

describe('ContextAudioBus — the autoplay gate (AUDIO_DESIGN.md §5)', () => {
  it('plays nothing while the context is still suspended', () => {
    // Not just "quiet now": a suspended context QUEUES its voices, so a bus that played anyway
    // would dump every backed-up cue at once the instant the gate opens.
    const h = bus({ state: 'suspended' });
    h.b.play('sfx.card.play');
    expect(h.ctx.of('oscillator')).toHaveLength(0);
    expect(h.ctx.of('bufferSource')).toHaveLength(0);
  });

  it('resumes a suspended context, and leaves a running one alone', () => {
    const h = bus({ state: 'suspended' });
    h.b.resume();
    expect(h.ctx.resumeCalls).toBe(1);
    h.b.resume(); // already running after the first resume
    expect(h.ctx.resumeCalls).toBe(1);
  });

  it('registers the host gesture source at construction, before any context exists', () => {
    // Ordering is the point: the first tap is the gate-opener, and it can land before anything
    // in the game has asked to play a sound.
    const h = bus({ state: 'suspended' });
    expect(h.gestures).toHaveLength(1);
    expect(h.creates()).toBe(0);
    h.gestures[0]!();
    expect(h.ctx.resumeCalls).toBe(1);
  });

  it('works on a host that offers no gesture source', () => {
    // `onGesture` is optional: a host whose context starts `running` needs no gate at all.
    const ctx = fakeAudioContext();
    const b = new ContextAudioBus({ createContext: () => asCtx(ctx) });
    b.play('sfx.ui.tap');
    expect(ctx.of('gain').length).toBeGreaterThan(1); // bus gain + the cue's own
  });

  it('actually emits sound once the context is running', () => {
    const h = bus();
    h.b.play('sfx.card.play');
    const voices = [...h.ctx.of('oscillator'), ...h.ctx.of('bufferSource')];
    expect(voices.length).toBeGreaterThan(0);
    for (const v of voices) expect(v.started.length).toBe(1);
  });

  it('forwards the same-frame coalesce count instead of playing the cue twice', () => {
    // AUDIO_DESIGN.md §0.2 (C): naively playing n copies of a tone cue is exactly n times as
    // loud (8x at n=8), which is why `count` raises gain instead. If this arg were dropped, the
    // mix would be quiet rather than broken — nothing else would ever go red.
    const one = bus();
    one.b.play('sfx.unit.hit', 1);
    const many = bus();
    many.b.play('sfx.unit.hit', 8);
    expect(many.busNode()).toBeDefined();
    const gainOf = (h: ReturnType<typeof bus>) => {
      const cueGains = h.ctx.of('gain').filter((g) => !g.out.includes(h.ctx.destination));
      return Math.max(...cueGains.flatMap((g) => [g.gain!.value, ...g.gain!.ramps.map(([, v]) => v)]));
    };
    expect(gainOf(many)).toBeGreaterThan(gainOf(one));
  });
});

describe('ContextAudioBus — volume', () => {
  it('applies a volume set before the context existed', () => {
    // `installAudioSettings` restores the player's saved level during startup, which can easily
    // run before the first `preload()`/tap. Dropping it would reset everyone to the default.
    const h = bus();
    h.b.setSfxVolume(0.25);
    void h.b.preload();
    expect(h.busNode()!.gain!.value).toBeCloseTo(0.25);
  });

  it('clamps to 0..1', () => {
    const h = bus();
    void h.b.preload();
    h.b.setSfxVolume(4);
    expect(h.busNode()!.gain!.value).toBe(1);
    h.b.setSfxVolume(-1);
    expect(h.busNode()!.gain!.value).toBe(0);
  });

  it('accepts and ignores a music volume, so the settings slider can be wired early', () => {
    // AUDIO_DESIGN.md §4: "a slider that does nothing" beats "no slider at all", because the
    // slider is definitely going to exist (§7 step 7).
    const h = bus();
    void h.b.preload();
    const before = h.ctx.nodes.length;
    h.b.setMusicVolume(0.1);
    expect(h.ctx.nodes).toHaveLength(before);
  });
});

describe('ContextAudioBus — preload', () => {
  it('degrades to the synth voice per FILE, and says so, when every read fails', async () => {
    // Rewritten 2026-09-01: this case used to assert `{cues: 0, variants: 0}` because
    // `cueAssets.ts` was empty. It is not any more (22 files across 10 cues), and what is worth
    // pinning now is the shape of the failure rather than the count — the reader rejects
    // everything here (see the beforeEach), so preload must still RESOLVE, report an honest
    // zero, and account for each file it could not use. "Assets are broken" must never be able
    // to become "audio is gone": every cue has a procedural voice underneath it.
    const h = bus();
    await h.b.preload();
    expect(h.b.loaded).toEqual({ cues: 0, variants: 0 });
    // One warning per shipped variant, which is the count `cueAssets.ts` declares.
    expect(h.warnings).toHaveLength(allSfxUrls().length);
    expect(h.warnings.every((w) => w.includes('退回合成音'))).toBe(true);
  });

  it('decodes without waiting for the autoplay gate', async () => {
    // A suspended context can still decode, which is why startup fires this and never awaits it.
    const h = bus({ state: 'suspended' });
    await h.b.preload();
    expect(h.ctx.state).toBe('suspended');
    expect(h.busNode()).toBeDefined();
  });
});

describe('ContextAudioBus — the field names the e2e measurement surface reflects on', () => {
  it('keeps `ctx` and `sfx` reachable by name', () => {
    // `entries/web-e2e.ts`'s `__nwAudio.nodes()` reaches through TS privacy for exactly these
    // two names to hang an AnalyserNode on the bus and read the DELIVERED peak — the whole
    // basis of every figure in AUDIO_DESIGN.md §0/§0.1/§0.2. Renaming either field breaks that
    // silently: it is a runtime reflection, so the compiler says nothing and no other test
    // notices. This case is the compiler's stand-in.
    const h = bus();
    void h.b.preload();
    const priv = h.b as unknown as { ctx: FakeAudioContext | null; sfx: unknown };
    expect(priv.ctx).toBe(h.ctx);
    expect(priv.sfx).toBe(h.busNode());
  });

  it('keeps `bank` reachable by name, with `variantsOf` on it', () => {
    // Same class of silent breakage, one surface later (2026-09-01): `__nwAudio.samples()` reads
    // the peak of every DECODED buffer by reflecting on `bank` and calling `variantsOf(cue)`.
    // That is the only way to check the thing the asset pipeline structurally cannot check about
    // its own output — it peak-matches BEFORE a lossy MP3 encode (AUDIO_DESIGN §0.4). Rename the
    // field or the method and `samples()` returns an empty array forever: no error, no failing
    // test, and the next person concludes the measurement surface never worked.
    const h = bus();
    void h.b.preload();
    const priv = h.b as unknown as { bank: { variantsOf?: unknown } | null };
    expect(priv.bank).toBeTruthy();
    expect(typeof priv.bank!.variantsOf).toBe('function');
  });
});

// ── the music half (AUDIO_DESIGN.md §2.3 / §7 step 7) ────────────────────────────────────────
//
// The point of these cases is the SEPARATION: music does not go through the `AudioContext` at
// all (a cross-origin `createMediaElementSource` yields a silent stream — see `MusicPlayer.ts`),
// so every way the two halves could accidentally become coupled is a real bug that would only
// ever be noticed by ear.
describe('ContextAudioBus — BGM', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts the track without ever building an AudioContext', () => {
    // SFX are gated on `ctx.state === 'running'`; music must not be. A player who lands in the
    // lobby and does not tap for ten seconds should hear music for those ten seconds.
    const h = bus();
    h.b.playMusic('bgm.lobby');
    expect(h.music.loads).toHaveLength(1);
    expect(h.music.plays).toBe(1);
    expect(h.creates()).toBe(0);
  });

  it('plays music on a suspended context — the autoplay gates are separate ones', () => {
    const h = bus({ state: 'suspended' });
    h.b.play('sfx.ui.tap');          // dropped: SFX before the gate would pile up
    h.b.playMusic('bgm.lobby');
    expect(h.music.plays).toBe(1);
  });

  it('pushes the BGM channel volume through, before and after a track exists', () => {
    const h = bus();
    h.b.setMusicVolume(0.25);
    h.b.playMusic('bgm.lobby');
    vi.advanceTimersByTime(FADE_IN_MS);
    expect(h.music.volume).toBeCloseTo(0.25 * MUSIC_TRACKS['bgm.lobby'].gain, 6);
    h.b.setMusicVolume(0.5);
    expect(h.music.volume).toBeCloseTo(0.5 * MUSIC_TRACKS['bgm.lobby'].gain, 6);
  });

  it('starts at the shipped BGM default rather than at full volume', () => {
    // If the bus started the music channel at 1.0, every player whose settings have not loaded
    // yet (or who never opens settings) hears the bed twice as loud as designed.
    const h = bus();
    h.b.playMusic('bgm.lobby');
    vi.advanceTimersByTime(FADE_IN_MS);
    expect(h.music.volume).toBeCloseTo(DEFAULT_MUSIC_VOLUME * MUSIC_TRACKS['bgm.lobby'].gain, 6);
  });

  it('a gesture resumes BOTH halves — the context and the rejected stream', () => {
    const h = bus({ state: 'suspended' });
    h.b.playMusic('bgm.lobby');
    expect(h.music.plays).toBe(1);
    h.gestures.forEach((cb) => cb());
    expect(h.ctx.resumeCalls).toBeGreaterThan(0);
    expect(h.music.plays).toBe(2);
  });

  it('backgrounding pauses the music (and only the music)', () => {
    const h = bus();
    h.b.playMusic('bgm.lobby');
    vi.advanceTimersByTime(FADE_IN_MS);
    h.visibility.forEach((cb) => cb(false));
    expect(h.music.pauses).toBe(1);
    h.visibility.forEach((cb) => cb(true));
    expect(h.music.plays).toBe(2);
  });

  it('a host with no music device stays silent instead of throwing', () => {
    // node's unit environment has a fake AudioContext but no `HTMLAudioElement`; that combination
    // is real, not hypothetical, and SFX must be unaffected by it.
    for (const music of ['absent', 'throws'] as const) {
      const h = bus({ music });
      expect(() => h.b.playMusic('bgm.lobby')).not.toThrow();
      expect(() => h.b.setMusicVolume(0.5)).not.toThrow();
      expect(h.b.musicState).toBeNull();
      h.b.play('sfx.ui.tap');
      expect(h.ctx.of('gain').length).toBeGreaterThan(0);
    }
  });

  it('exposes the player state the e2e probe reads', () => {
    // `__nwAudio.music()` is the only way to check the delivered music level in a real browser:
    // the stream is not in the graph, so no AnalyserNode can see it (AUDIO_DESIGN §0.5).
    const h = bus();
    expect(h.b.musicState).toMatchObject({ want: null, loaded: null });
    h.b.playMusic('bgm.lobby');
    vi.advanceTimersByTime(FADE_IN_MS);
    expect(h.b.musicState).toMatchObject({ want: 'bgm.lobby', loaded: 'bgm.lobby', level: 1 });
  });
});
