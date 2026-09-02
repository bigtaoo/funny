import type * as PIXI from 'pixi.js-legacy';
import { startApp } from '../app';
import { WebPlatform } from '../platform/web/WebPlatform';
import type { AppViews } from '../app/AppViews';
import { setAudioBus, audioBus } from '../audio/audioBus';
import type { AudioBus, AudioCue, MusicTrack } from '../audio/types';
import type { MusicPlayer, MusicDeck } from '../audio/MusicPlayer';
import { ALL_CUES } from '../audio/cueCatalogue';
import { WebAudioBus } from '../platform/web/WebAudioBus';

// Test-only entry (client/test/browser Playwright specs) — boots the exact same real
// PixiJS/WebGL app as entries/web.ts, but wraps AppViews so a Playwright script can drive
// scene transitions by calling the real scene callbacks directly (window.__nwE2E) instead of
// clicking pixel coordinates on a single full-screen <canvas> with no per-widget DOM presence.
// Never referenced by any production entry (web/wechat/mobile/crazygames) — only reachable via
// `webpack --env TARGET=web-e2e` (see claudedocs/client-testing.md 缺口B).
//
// This is a different animal from the throwaway one-off debug global that
// test/no-debug-hooks-in-src.test.ts scans for and fails CI on: __nwE2E is permanent, deliberate
// test infrastructure isolated to this never-shipped entry file, not a forgotten scratch hook.

interface E2EState {
  screen?: string;
  [key: string]: unknown;
}

/**
 * Wraps every `show*` method (and the `apply*` push methods on any handle it returns) so a
 * Playwright script reading `window.__nwE2E.state` can see the current screen + the scene
 * callback object for it (`state.<screen>Cb`, e.g. `state.loginCb.onRegister(...)`) and the last
 * pushed value for any handle (`state.last<Xxx>`, e.g. `state.lastRoomState`) — mirroring the
 * `screen`/`lastRoomState` conventions test/harness/HeadlessAppViews.ts already uses for the
 * headless full-link E2E, so the two harnesses read the same way.
 */
function instrumentViews(views: AppViews): AppViews {
  const state: E2EState = {};
  const v = views as unknown as Record<string, (...a: unknown[]) => unknown>;
  const proto = Object.getPrototypeOf(views);
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (!key.startsWith('show') || typeof v[key] !== 'function') continue;
    const orig = v[key].bind(views);
    const screenKey = key[4].toLowerCase() + key.slice(5);
    v[key] = (...args: unknown[]) => {
      state.screen = screenKey;
      state[`${screenKey}Cb`] = args[0];
      const handle = orig(...args);
      if (handle && typeof handle === 'object') {
        const h = handle as Record<string, (...a: unknown[]) => unknown>;
        for (const hKey of Object.keys(h)) {
          if (typeof h[hKey] !== 'function') continue;
          const origH = h[hKey].bind(h);
          h[hKey] = (...hArgs: unknown[]) => {
            if (hKey.startsWith('apply')) {
              // Server/core push, e.g. applyRoomState → state.lastRoomState.
              state[`last${hKey.slice(5)}`] = hArgs[0];
            } else {
              // One-shot UI call the core makes on the handle, e.g. showFeatureGuide(title, body,
              // onDismiss) for the first-time feature-guide gate (ONBOARDING_DESIGN §4.1) that sits
              // in front of most lobby-reachable features. Record the args, and if the last one is a
              // callback (the guide's onDismiss / a toast's onTap convention) expose it directly so a
              // Playwright script can invoke it to get past the gate: state.<name>Cb().
              state[`${hKey}Args`] = hArgs;
              const lastArg = hArgs[hArgs.length - 1];
              if (typeof lastArg === 'function') state[`${hKey}Cb`] = lastArg;
            }
            return origH(...hArgs);
          };
        }
      }
      return handle;
    };
  }
  // `app` too, so a Playwright script can walk the real display tree (`app.stage`) and assert on
  // measured geometry instead of eyeballing a screenshot — the only way to check text layout with
  // the REAL font, since the headless harness's `measureText` mock is a flat 7px/char and
  // font-size-independent (see claudedocs/client-testing.md). Read off the `private readonly app`
  // field rather than plumbed through `startApp`: `wrapViews` is the only injection point that
  // exists and it is handed the views instance alone, and TS privacy is erased at runtime. A
  // production seam for a test-only need would be the worse trade.
  const app = (views as unknown as { app?: PIXI.Application }).app;
  (window as unknown as {
    __nwE2E: { views: AppViews; state: E2EState; app?: PIXI.Application };
  }).__nwE2E = { views, state, app };
  return views;
}

// Audio: the same backend the web entry installs, plus a handle on `window.__nwAudio` so a
// browser smoke can fire a cue and measure the SFX bus. Audio has no other observable surface —
// it cannot be screenshotted, and until the trigger points are wired (AUDIO_DESIGN.md §7 steps
// 3-4) nothing in the game fires a cue at all, so without this there is no way to hear or
// measure the pipeline end to end in a real browser. Permanent test infrastructure in the
// never-shipped e2e entry, exactly like __nwE2E above — not one of the throwaway debug globals
// test/no-debug-hooks-in-src.test.ts scans src/ for. (That guard matches the offending token as a
// literal, so this comment deliberately does not spell it out.)
const audio = new WebAudioBus();

// Cue log. An `AnalyserNode` on the SFX bus can tell you *something played* and how loud, but not
// *which cue* — and once the battle triggers are wired (AUDIO_DESIGN.md §7 step 3) a real match
// fires them faster than any human can attribute a peak to an event. Wrapping the bus here is the
// only way to answer "did `card_played` reach `sfx.card.play`, once?" against the real game rather
// than against a fake bus in vitest. It also makes the game-over hazard measurable: a stinger
// re-firing every frame shows up as hundreds of entries, not one.
interface CueLogEntry { cue: string; count: number; t: number }
const CUE_LOG_CAP = 4000;
const cueLog: CueLogEntry[] = [];
/** What the scene layer has ASKED for, newest last — one entry per change (see `updateMusic`). */
interface MusicLogEntry { track: MusicTrack | null; t: number }
const musicLog: MusicLogEntry[] = [];
let lastMusicAsk: MusicTrack | null | undefined;
const recordingBus: AudioBus = {
  preload: () => audio.preload(),
  play: (cue, count = 1) => {
    if (cueLog.length >= CUE_LOG_CAP) cueLog.shift();
    cueLog.push({ cue, count, t: Math.round(performance.now()) });
    audio.play(cue, count);
  },
  setSfxVolume: (v) => audio.setSfxVolume(v),
  setMusicVolume: (v) => audio.setMusicVolume(v),
  // Logged on CHANGE, not per frame: this runs 60 times a second in every phase, so recording
  // each call would bury the cue log under 3600 entries a minute and say nothing — what a smoke
  // needs to know is when the bed was asked to change and to what.
  updateMusic: (desired, dtMs) => {
    if (desired !== lastMusicAsk) {
      lastMusicAsk = desired;
      musicLog.push({ track: desired, t: Math.round(performance.now()) });
    }
    audio.updateMusic(desired, dtMs);
  },
  resume: () => audio.resume(),
};
setAudioBus(recordingBus);
(window as unknown as { __nwAudio: unknown }).__nwAudio = {
  play: (cue: string, count?: number) => audioBus().play(cue as never, count),
  resume: () => audioBus().resume(),
  cues: ALL_CUES,
  /** How much of the shipped sample set actually decoded. Since 2026-09-01: expect 10 cues / 22 variants. */
  loaded: () => audio.loaded,
  /** Every cue the trigger layer has asked for, newest last. */
  log: (): CueLogEntry[] => cueLog.slice(),
  clearLog: (): void => { cueLog.length = 0; },
  /** Every BGM track the scene layer has asked for, newest last (one entry per CHANGE). */
  musicLog: (): MusicLogEntry[] => musicLog.slice(),
  /**
   * What the BGM runtime is actually doing right now (AUDIO_DESIGN.md §7 step 7).
   *
   * Music is the one part of this system with **no** peak-based observable: the two decks are
   * streamed, never decoded into the `SampleBank`, so `samples()` cannot see them and an
   * `AnalyserNode` on the SFX bus is on the wrong bus entirely. What actually has to be checked
   * is behavioural and invisible to every other surface:
   *
   *  - **the wrap fires where it was measured for.** `xfade_band_diff` accepted each track over
   *    a 2 s window at a specific seam; a `lengthS` that drifts from the file puts the crossfade
   *    somewhere nobody measured, and the only symptom is that the loop sounds slightly wrong
   *    once a minute.
   *  - **the two decks hand over.** `position()` per deck says whether the incoming stream is
   *    really running while the outgoing one plays out, or whether one of them silently failed
   *    (CORS on web, a missing file on WeChat) and the bed just stopped.
   *  - **ducking returns to 1.** A duck that sticks is a bed that is quietly 6.9 dB low forever.
   *
   * Reaches through TS privacy exactly like `nodes()` and `samples()`, for the same reason.
   */
  music: (): {
    track: MusicTrack | null; crossfading: boolean; duck: number;
    decks: { position: number | null; gain: number }[];
  } | null => {
    const priv = audio as unknown as { music: MusicPlayer | null };
    const p = priv.music;
    if (!p) return null;
    const decks = (p as unknown as { deps: { decks: readonly MusicDeck[] } }).deps.decks;
    return {
      track: p.current,
      crossfading: p.isCrossfading,
      duck: p.duckLevel,
      decks: decks.map((d) => ({
        position: d.position(),
        // The deck's own live output level, read from the platform object rather than from what
        // the player last wrote — the two disagreeing is precisely the failure this exists for.
        gain: (d as unknown as { gain?: GainNode; inner?: { volume: number } }).gain?.gain.value
          ?? (d as unknown as { inner?: { volume: number } }).inner?.volume ?? 0,
      })),
    };
  },
  /**
   * The live `AudioContext` and the SFX bus `GainNode`, so a browser smoke can hang an
   * `AnalyserNode` off the bus and read the **delivered** PCM peak. That distinction is the whole
   * point: `audioSynth.ts` authors a gain *before* the per-cue filters, and how much of it
   * survives depends on the cutoff — AUDIO_DESIGN.md §0 records `sfx.unit.hit` authoring 0.15 and
   * delivering 0.063, i.e. the mix reading backwards from the catalogue's intent. No unit test can
   * see that layer; only a real context can.
   *
   * Reaches through TS privacy exactly like `views.app` above, and for the same reason: a
   * production seam (`WebAudioBus.busNode`) existing solely for a test would be the worse trade.
   * Both are null until `ensure()` has run — in practice `preload()` runs it during startup.
   */
  nodes: (): { ctx: AudioContext | null; sfx: GainNode | null } => {
    const priv = audio as unknown as { ctx: AudioContext | null; sfx: GainNode | null };
    return { ctx: priv.ctx, sfx: priv.sfx };
  },
  /**
   * The measured peak of every **decoded** sample buffer, per cue and variant.
   *
   * This answers the one question `tools/audio-pipeline/process.py` structurally cannot answer
   * about its own output. The pipeline scales each file to a target peak and *then* encodes to
   * MP3 — and MP3 is lossy, so the decoded waveform is not the one that was written. It can
   * overshoot. If it overshoots by 20% on one cue, that cue is 20% louder than
   * `cueCatalogue.ts` says it is, the mix drifts from the design, and **nothing anywhere
   * fails**: the file loads, decodes, plays, and passes `audit.py` (which measures the file,
   * not the decode) and `audioAssets.test.ts` (which measures the bytes, not the audio).
   *
   * Deliberately independent of the autoplay gate: a suspended context decodes fine
   * (AUDIO_DESIGN.md §5), so this is readable in a background tab with no user gesture — which
   * matters, because the gesture is the part of a browser smoke that is awkward to automate.
   *
   * Reaches through TS privacy for `bank` for the same reason `nodes()` reaches for `ctx`/`sfx`.
   */
  samples: (): { cue: string; variant: number; peak: number; ms: number; rate: number }[] => {
    const priv = audio as unknown as {
      bank: { variantsOf(cue: AudioCue): readonly AudioBuffer[] | undefined } | null;
    };
    const bank = priv.bank;
    if (!bank) return [];
    const out: { cue: string; variant: number; peak: number; ms: number; rate: number }[] = [];
    for (const cue of ALL_CUES) {
      const variants = bank.variantsOf(cue);
      if (!variants) continue;
      variants.forEach((buf, variant) => {
        let peak = 0;
        for (let ch = 0; ch < buf.numberOfChannels; ch++) {
          const d = buf.getChannelData(ch);
          for (let i = 0; i < d.length; i++) {
            const v = Math.abs(d[i]!);
            if (v > peak) peak = v;
          }
        }
        out.push({
          cue,
          variant,
          peak,
          ms: Math.round(buf.duration * 1000),
          rate: buf.sampleRate,
        });
      });
    }
    return out;
  },
};

startApp(new WebPlatform('game-canvas'), instrumentViews).catch(console.error);
