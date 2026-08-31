// A recording stand-in for `AudioContext`, shared by the audio suites.
//
// Not a `.test.ts` file, so vitest's `test/**/*.test.ts` include never collects it.
//
// Records every node created and every `connect()` edge, so a test can assert the SHAPE of what
// a cue built (how many oscillators, which frequencies, what gain landed on the bus) instead of
// only that a call did not throw. That distinction is the whole point here: audio's failure mode
// is silent, and "playCue didn't throw" is true of an implementation that builds nothing at all.

export interface FakeParam {
  value: number;
  /** [time, value] pairs from setValueAtTime, in call order. */
  sets: [number, number][];
  /** [time, value] pairs from linearRampToValueAtTime, in call order. */
  ramps: [number, number][];
  setValueAtTime(v: number, t: number): void;
  linearRampToValueAtTime(v: number, t: number): void;
}

function param(initial = 0): FakeParam {
  const p: FakeParam = {
    value: initial,
    sets: [],
    ramps: [],
    setValueAtTime(v, t) {
      p.sets.push([t, v]);
      p.value = v;
    },
    linearRampToValueAtTime(v, t) {
      p.ramps.push([t, v]);
    },
  };
  return p;
}

export interface FakeBuffer {
  duration: number;
  length: number;
  sampleRate: number;
  /** The PCM the code under test wrote — noise() bakes its envelope in here. */
  data: Float32Array;
  getChannelData(ch: number): Float32Array;
}

export type FakeNodeKind = 'gain' | 'oscillator' | 'bufferSource' | 'biquad' | 'destination';

export interface FakeNode {
  kind: FakeNodeKind;
  /** Nodes this one is connected INTO, in connect() order. */
  out: FakeNode[];
  gain?: FakeParam;
  frequency?: FakeParam;
  playbackRate?: FakeParam;
  type?: string;
  buffer?: FakeBuffer | AudioBuffer | null;
  /** Context times passed to start(), in call order. */
  started: number[];
  /** Context times passed to stop(), in call order. */
  stopped: number[];
  connect(target: FakeNode): FakeNode;
  start(t?: number): void;
  stop(t?: number): void;
}

function node(kind: FakeNodeKind): FakeNode {
  const n: FakeNode = {
    kind,
    out: [],
    started: [],
    stopped: [],
    connect(target) {
      n.out.push(target);
      return target;
    },
    start(t = 0) {
      n.started.push(t);
    },
    stop(t = 0) {
      n.stopped.push(t);
    },
  };
  return n;
}

export interface FakeAudioContext {
  currentTime: number;
  sampleRate: number;
  state: 'suspended' | 'running' | 'closed';
  destination: FakeNode;
  /** Every node ever created, in creation order. */
  nodes: FakeNode[];
  resumeCalls: number;
  /** Queued results for decodeAudioData, consumed in call order. */
  decodeResults: (AudioBuffer | Error)[];
  decodeCalls: ArrayBuffer[];
  createGain(): FakeNode;
  createOscillator(): FakeNode;
  createBufferSource(): FakeNode;
  createBiquadFilter(): FakeNode;
  createBuffer(channels: number, length: number, rate: number): FakeBuffer;
  resume(): Promise<void>;
  decodeAudioData(
    data: ArrayBuffer,
    ok?: (b: AudioBuffer) => void,
    fail?: (e: unknown) => void,
  ): Promise<AudioBuffer> | undefined;
  /** Nodes of one kind, in creation order. */
  of(kind: FakeNodeKind): FakeNode[];
}

export function fakeAudioContext(opts: { sampleRate?: number; now?: number } = {}): FakeAudioContext {
  const ctx: FakeAudioContext = {
    currentTime: opts.now ?? 0,
    sampleRate: opts.sampleRate ?? 48000,
    state: 'running',
    destination: node('destination'),
    nodes: [],
    resumeCalls: 0,
    decodeResults: [],
    decodeCalls: [],
    createGain() {
      const n = node('gain');
      n.gain = param(1);
      ctx.nodes.push(n);
      return n;
    },
    createOscillator() {
      const n = node('oscillator');
      n.frequency = param(440);
      n.type = 'sine';
      ctx.nodes.push(n);
      return n;
    },
    createBufferSource() {
      const n = node('bufferSource');
      n.playbackRate = param(1);
      n.buffer = null;
      ctx.nodes.push(n);
      return n;
    },
    createBiquadFilter() {
      const n = node('biquad');
      n.frequency = param(350);
      n.type = 'lowpass';
      ctx.nodes.push(n);
      return n;
    },
    createBuffer(_channels, length, rate) {
      const data = new Float32Array(length);
      return {
        duration: length / rate,
        length,
        sampleRate: rate,
        data,
        getChannelData: () => data,
      };
    },
    async resume() {
      ctx.resumeCalls++;
      ctx.state = 'running';
    },
    decodeAudioData(data, ok, fail) {
      ctx.decodeCalls.push(data);
      const next = ctx.decodeResults.shift();
      if (next instanceof Error) fail?.(next);
      else if (next) ok?.(next);
      return undefined;
    },
    of(kind) {
      return ctx.nodes.filter((n) => n.kind === kind);
    },
  };
  return ctx;
}

/**
 * Cast helper. The fake implements only the slice of `AudioContext` the audio layer touches —
 * the cast is the seam, and it is confined to this file so a real API drift shows up as a
 * compile error in the code under test rather than being papered over per-test.
 */
export function asCtx(ctx: FakeAudioContext): AudioContext {
  return ctx as unknown as AudioContext;
}

/** A gain node from the fake, typed as the real thing for the code under test. */
export function asGain(n: FakeNode): GainNode {
  return n as unknown as GainNode;
}

/** A stand-in decoded buffer of `duration` seconds. */
export function fakeBuffer(duration: number): AudioBuffer {
  return {
    duration,
    length: Math.round(duration * 48000),
    sampleRate: 48000,
    numberOfChannels: 1,
  } as unknown as AudioBuffer;
}
