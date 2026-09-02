// IMPORTANT: @pixi/unsafe-eval must be imported first on WeChat
import '@pixi/unsafe-eval';

// WeChat measurement entry — the mini-game twin of `web-e2e.ts`, and never shipped.
//
// **Why this exists as an entry instead of a script poked into a running game.** On web, the
// equivalent surface is `window.__nwAudio`, and a browser smoke reaches it by evaluating JS in
// the page. There is no such reach here: the mini-game bundle is a single self-executing IIFE
// exporting nothing, and WeChat DevTools' automation port speaks the mini-*program* protocol —
// `miniprogram-automator` connects (the socket opens) but every `evaluate` / `callWxMethod` call
// hangs forever, because a mini-game has no appservice for those commands to reach. Measured
// 2026-08-31; that dead end is the reason this file is an entry.
//
// **How the results get out**: `wx.env.USER_DATA_PATH` is a real directory on disk under the IDE's
// user-data folder, so the probe writes one JSON file and the harness reads it. No network (so no
// `urlCheck` / domain-whitelist change), no console scraping, no GUI step.
//
// **What it measures, and why a unit test cannot.** AUDIO_DESIGN.md §0/§0.2 established the rule
// this file serves: authored peak != delivered peak. `audioSynth.ts` authors a gain BEFORE the
// per-cue biquads, and how much survives depends on the cutoff (noise cues) and on whether the
// notes overlap (tone cues). A unit test reads the gain off the node graph and sees neither layer.
// The claim this whole change rests on — "the platform-neutral pipeline runs UNCHANGED on
// `wx.createWebAudioContext()`" — is therefore only testable by running the real synth on a real
// WeChat context and reading the PCM off the SFX bus, exactly as §0.2 did on Chrome.
import { WechatAudioBus } from '../platform/wechat/WechatAudioBus';
import { ALL_CUES } from '../audio/cueCatalogue';
import type { AudioCue } from '../audio/types';

declare const wx: {
  env: { USER_DATA_PATH: string };
  createWebAudioContext?(): AudioContext;
  getSystemInfoSync(): { SDKVersion?: string; platform?: string; system?: string };
  getFileSystemManager(): { writeFileSync(p: string, data: string, enc: 'utf8'): void };
  setEnableDebug(opts: { enableDebug: boolean }): void;
};

// Real-device "预览" ships with no attached console and no visible way to reach one — DevTools'
// own remote-debug bridge cannot even load a WeChat bundle containing ES2020 syntax
// (ASSET_PACKAGING_LOG.md §20.2), so the `console.log` lines this file relies on as exit #3 are
// otherwise unreachable on a real phone. Unconditional here — safe only because this entry is
// `build:wechat-e2e`, never shipped (see file header).
try { wx.setEnableDebug({ enableDebug: true }); } catch { /* older base library: no-op, not fatal */ }

console.log('[nw-audio-probe] entry loaded');
const OUT = `${wx.env.USER_DATA_PATH}/nw-audio-probe.json`;
/** Repeats per cue. AUDIO_DESIGN.md §0.2 (C): noise cues jitter 27-38% run to run, tone cues <1%,
 *  so a single sample cannot rank two cues. Ten is the floor that section set for a median. */
const REPEATS = 10;
/** Long enough for the longest cue (`sfx.result.victory`, ~0.35 s) plus its tail. */
const CUE_WINDOW_MS = 700;

interface Report {
  when: string;
  system: Record<string, unknown>;
  api: Record<string, string>;
  ctx: Record<string, unknown>;
  meter: string;
  silenceBaseline: number | null;
  cues: Record<string, { peaks: number[]; median: number; min: number; max: number }>;
  errors: string[];
}

const report: Report = {
  when: new Date().toISOString(),
  system: {},
  api: {},
  ctx: {},
  meter: 'none',
  silenceBaseline: null,
  cues: {},
  errors: [],
};

function write(): void {
  // Three independent exits, because each one has a way of not being there. The FILE is the only
  // headless one (and the only one that survives to a real device's log upload); `GameGlobal` is
  // the reach for anyone with a console attached; the console line is what tells a human the probe
  // ran at all when the other two turn up empty — which is exactly the state that cost this round
  // an hour: nothing on disk is equally consistent with "the probe failed" and "the simulator
  // never ran it", and those need very different fixes.
  (GameGlobal as Record<string, unknown>).__nwAudioProbe = report;
  try {
    wx.getFileSystemManager().writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  } catch (e) {
    report.errors.push('writeFileSync failed: ' + String(e));
  }
  console.log('[nw-audio-probe]', JSON.stringify(report));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * A peak meter on the SFX bus. Prefers `ScriptProcessorNode` for the same reason §0.2 did: it sees
 * EVERY sample, while polling an `AnalyserNode` steps over the transient of a 40 ms UI cue. The
 * analyser is the fallback, and the report says which one produced the numbers — a figure read by
 * a poller is not comparable to one read sample-by-sample, and silently mixing the two would
 * corrupt the very comparison this probe exists to make.
 */
function attachMeter(ctx: AudioContext, bus: GainNode): () => number {
  const anyCtx = ctx as unknown as {
    createScriptProcessor?: (n: number, i: number, o: number) => ScriptProcessorNode;
    createAnalyser?: () => AnalyserNode;
  };
  let peak = 0;
  if (typeof anyCtx.createScriptProcessor === 'function') {
    const node = anyCtx.createScriptProcessor(2048, 1, 1)!;
    node.onaudioprocess = (ev: AudioProcessingEvent) => {
      const buf = ev.inputBuffer.getChannelData(0);
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]!);
        if (v > peak) peak = v;
      }
    };
    bus.connect(node);
    // A ScriptProcessorNode only pulls audio while it is itself connected onward. Routing it to a
    // muted gain rather than to `destination` keeps the meter from doubling the signal the player
    // (and the meter) hears.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(ctx.destination);
    report.meter = 'ScriptProcessorNode';
  } else if (typeof anyCtx.createAnalyser === 'function') {
    const an = anyCtx.createAnalyser()!;
    an.fftSize = 2048;
    bus.connect(an);
    const buf = new Float32Array(an.fftSize);
    const tick = (): void => {
      an.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]!);
        if (v > peak) peak = v;
      }
      setTimeout(tick, 4);
    };
    tick();
    report.meter = 'AnalyserNode(polled 4ms)';
  } else {
    report.errors.push('no ScriptProcessorNode and no AnalyserNode: cannot measure delivered peak');
  }
  return () => {
    const p = peak;
    peak = 0;
    return p;
  };
}

async function main(): Promise<void> {
  const sys = wx.getSystemInfoSync();
  report.system = { SDKVersion: sys.SDKVersion, platform: sys.platform, system: sys.system };
  for (const name of ['createWebAudioContext', 'createInnerAudioContext', 'onTouchStart', 'onAudioInterruptionBegin', 'onAudioInterruptionEnd'] as const) {
    report.api[name] = typeof (wx as unknown as Record<string, unknown>)[name];
  }
  if (typeof wx.createWebAudioContext !== 'function') {
    report.errors.push('wx.createWebAudioContext absent — the whole premise of WechatAudioBus');
    write();
    return;
  }

  // The real bus, not a hand-rolled context: the point is to measure OUR pipeline on THIS runtime.
  const bus = new WechatAudioBus();
  await bus.preload();
  const priv = bus as unknown as { ctx: AudioContext | null; sfx: GainNode | null };

  // No gesture is available headlessly, so ask directly and then report what the state actually
  // settled to. If it stays suspended, that is itself the finding (someone must tap the simulator),
  // not a failed run — so it is recorded rather than thrown.
  bus.resume();
  for (let i = 0; i < 40 && priv.ctx?.state !== 'running'; i++) await sleep(50);

  const ctx = priv.ctx;
  const sfx = priv.sfx;
  report.ctx = {
    built: !!ctx,
    state: ctx?.state ?? null,
    sampleRate: ctx?.sampleRate ?? null,
    busGain: sfx?.gain.value ?? null,
    factories: ctx
      ? Object.fromEntries(
          (['createGain', 'createOscillator', 'createBufferSource', 'createBiquadFilter', 'createBuffer', 'createAnalyser', 'createScriptProcessor', 'decodeAudioData'] as const)
            .map((m) => [m, typeof (ctx as unknown as Record<string, unknown>)[m]]),
        )
      : null,
    loaded: bus.loaded,
  };
  if (!ctx || !sfx) {
    report.errors.push('bus built no context/gain');
    write();
    return;
  }

  const readPeak = attachMeter(ctx, sfx);

  // Silence baseline first (AUDIO_DESIGN.md §0 does the same): proves the meter is wired to a bus
  // with no DC offset and no self-noise, so a later non-zero reading means a cue and nothing else.
  await sleep(600);
  report.silenceBaseline = readPeak();

  for (const cue of ALL_CUES as readonly AudioCue[]) {
    const peaks: number[] = [];
    for (let i = 0; i < REPEATS; i++) {
      readPeak();
      bus.play(cue);
      await sleep(CUE_WINDOW_MS);
      peaks.push(Number(readPeak().toFixed(4)));
    }
    report.cues[cue] = {
      peaks,
      median: Number(median(peaks).toFixed(4)),
      min: Math.min(...peaks),
      max: Math.max(...peaks),
    };
    write(); // incremental, so a hang partway still leaves everything measured so far
  }
  write();
  console.log('[nw-audio-probe] done');
}

main().catch((e) => {
  report.errors.push(String(e));
  write();
});
