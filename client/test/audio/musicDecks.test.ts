import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebMusicDeck } from '../../src/platform/web/webMusicDeck';
import { WechatMusicDeck, type InnerAudio } from '../../src/platform/wechat/wechatMusicDeck';

// The two platform halves of `MusicDeck`. They are in `src/platform/**`, which was NOT in the
// coverage gate's include until this step — and §0.3 recorded exactly what that costs: "`src/audio/**`
// 100%" stayed true the whole time `WebAudioBus` had zero cases. Both files are added to the
// include with this suite, because neither is the 15-line pass-through the platform halves of the
// SFX bus are. Each carries branches that fail SILENTLY:
//
//   * web: `crossOrigin` (unset = the WebAudio graph outputs silence for CDN-hosted media, with no
//     error anywhere), and rewind-vs-assign on `play`.
//   * WeChat: the same rewind-vs-assign the other way round (`stop()` rewinds, re-assigning `src`
//     restarts), and the `Number.isFinite` guard — `currentTime` is undefined before a valid src
//     lands, and `NaN >= x` is false forever, i.e. a loop that never wraps again.

// ── web ────────────────────────────────────────────────────────────────────────────────────

class FakeGainNode {
  gain = { value: 0 };
  connect(): void {}
}
class FakeSourceNode {
  connect(): void {}
}
class FakeAudioContext {
  destination = {};
  created: FakeGainNode[] = [];
  sources: unknown[] = [];
  createGain(): FakeGainNode {
    const g = new FakeGainNode();
    this.created.push(g);
    return g;
  }
  createMediaElementSource(el: unknown): FakeSourceNode {
    this.sources.push(el);
    return new FakeSourceNode();
  }
}

class FakeAudioElement {
  src = '';
  crossOrigin: string | null = null;
  preload = '';
  loop = true;
  currentTime = 0;
  error: unknown = null;
  playCalls = 0;
  pauseCalls = 0;
  rejectPlay = false;
  private listeners: Record<string, (() => void)[]> = {};
  addEventListener(ev: string, cb: () => void): void {
    (this.listeners[ev] ??= []).push(cb);
  }
  emit(ev: string): void {
    for (const cb of this.listeners[ev] ?? []) cb();
  }
  play(): Promise<void> {
    this.playCalls++;
    return this.rejectPlay ? Promise.reject(new Error('blocked')) : Promise.resolve();
  }
  pause(): void {
    this.pauseCalls++;
  }
}

let lastEl: FakeAudioElement;
const origAudio = (globalThis as { Audio?: unknown }).Audio;

function makeWebDeck(): { deck: WebMusicDeck; el: FakeAudioElement; ctx: FakeAudioContext;
  warns: string[] } {
  const ctx = new FakeAudioContext();
  const warns: string[] = [];
  const deck = new WebMusicDeck({
    ctx: ctx as unknown as AudioContext,
    warn: (m) => warns.push(m),
  });
  return { deck, el: lastEl, ctx, warns };
}

describe('WebMusicDeck', () => {
  beforeEach(() => {
    (globalThis as { Audio?: unknown }).Audio = function Audio(this: unknown) {
      lastEl = new FakeAudioElement();
      return lastEl;
    } as unknown as typeof globalThis.Audio;
  });
  afterEach(() => {
    (globalThis as { Audio?: unknown }).Audio = origAudio;
  });

  it('sets crossOrigin — without it a CDN-hosted bed is silent with no error anywhere', () => {
    const { el } = makeWebDeck();
    expect(el.crossOrigin).toBe('anonymous');
  });

  it('turns native looping OFF (the player crossfades the wrap)', () => {
    const { el } = makeWebDeck();
    expect(el.loop).toBe(false);
  });

  it('routes through a gain node rather than the element volume', () => {
    // `HTMLMediaElement.volume` is read-only on iOS Safari — assignment is silently ignored — so
    // a deck that faded with it would hard-cut on the one target that is hardest to check.
    const { deck, ctx } = makeWebDeck();
    expect(ctx.created.length).toBe(1);
    deck.setGain(0.3);
    expect(ctx.created[0]!.gain.value).toBe(0.3);
  });

  it('assigns src on a new file and rewinds on the same file', () => {
    const { deck, el } = makeWebDeck();
    deck.play('/a.mp3');
    expect(el.src).toBe('/a.mp3');
    expect(el.playCalls).toBe(1);

    el.currentTime = 40;
    deck.play('/a.mp3');            // the wrap case: same file, start over
    expect(el.currentTime).toBe(0);
    expect(el.playCalls).toBe(2);

    deck.play('/b.mp3');
    expect(el.src).toBe('/b.mp3');
  });

  it('reports a position only while playing', () => {
    const { deck, el } = makeWebDeck();
    expect(deck.position()).toBeNull();
    deck.play('/a.mp3');
    el.currentTime = 12.5;
    expect(deck.position()).toBe(12.5);
    deck.stop();
    expect(deck.position()).toBeNull();
  });

  it('stop pauses and rewinds but keeps src — the next play is usually the wrap', () => {
    const { deck, el } = makeWebDeck();
    deck.play('/a.mp3');
    el.currentTime = 55;
    deck.stop();
    expect(el.pauseCalls).toBe(1);
    expect(el.currentTime).toBe(0);
    expect(el.src).toBe('/a.mp3');
    deck.stop();                      // idempotent
    expect(el.pauseCalls).toBe(1);
  });

  it('pauses and resumes without losing position', () => {
    const { deck, el } = makeWebDeck();
    deck.play('/a.mp3');
    el.currentTime = 20;
    deck.setPaused(true);
    expect(el.pauseCalls).toBe(1);
    expect(el.currentTime).toBe(20);
    deck.setPaused(false);
    expect(el.playCalls).toBe(2);
  });

  it('does nothing on pause/resume when it is not playing', () => {
    const { deck, el } = makeWebDeck();
    deck.setPaused(true);
    expect(el.pauseCalls).toBe(0);
  });

  it('reports an element error and stops claiming to play', async () => {
    const { deck, el, warns } = makeWebDeck();
    deck.play('/a.mp3');
    el.emit('error');
    expect(deck.position()).toBeNull();
    expect(warns.some((w) => w.includes('<audio> failed'))).toBe(true);
  });

  it('catches a rejected play() instead of leaving an unhandled rejection', async () => {
    const { deck, el, warns } = makeWebDeck();
    el.rejectPlay = true;
    deck.play('/a.mp3');
    await Promise.resolve();
    await Promise.resolve();
    expect(warns.some((w) => w.includes('refused to start'))).toBe(true);
    expect(deck.position()).toBeNull();
  });
});

// ── WeChat ─────────────────────────────────────────────────────────────────────────────────

class FakeInner {
  src = '';
  loop = true;
  volume = 1;
  currentTime: number = NaN;
  playCalls = 0;
  pauseCalls = 0;
  stopCalls = 0;
  private errCb: ((r: { errMsg: string; errCode: number }) => void) | null = null;
  play(): void { this.playCalls++; }
  pause(): void { this.pauseCalls++; }
  stop(): void { this.stopCalls++; }
  onError(cb: (r: { errMsg: string; errCode: number }) => void): void { this.errCb = cb; }
  fail(errMsg: string): void { this.errCb?.({ errMsg, errCode: 10001 }); }
}

function makeWxDeck(): { deck: WechatMusicDeck; inner: FakeInner; warns: string[] } {
  const inner = new FakeInner();
  const warns: string[] = [];
  const deck = new WechatMusicDeck({
    create: () => inner as unknown as InnerAudio,
    warn: (m) => warns.push(m),
  });
  return { deck, inner, warns };
}

describe('WechatMusicDeck', () => {
  it('turns native looping off and starts silent', () => {
    const { inner } = makeWxDeck();
    expect(inner.loop).toBe(false);
    expect(inner.volume).toBe(0);
  });

  it('writes the whole gain product into the single volume property', () => {
    // There is no audio graph on this runtime, so `.volume` is the only knob — which is why the
    // product is formed in `MusicPlayer` and the deck interface has exactly one gain entry point.
    const { deck, inner } = makeWxDeck();
    deck.setGain(0.42);
    expect(inner.volume).toBe(0.42);
    deck.setGain(2);      // clamped
    expect(inner.volume).toBe(1);
    deck.setGain(-1);
    expect(inner.volume).toBe(0);
  });

  it('assigns src on a new file and uses stop() to rewind the same file', () => {
    const { deck, inner } = makeWxDeck();
    deck.play('/a.mp3');
    expect(inner.src).toBe('/a.mp3');
    expect(inner.playCalls).toBe(1);
    expect(inner.stopCalls).toBe(0);

    deck.play('/a.mp3');            // the wrap case
    expect(inner.stopCalls).toBe(1);
    expect(inner.playCalls).toBe(2);

    deck.play('/b.mp3');
    expect(inner.src).toBe('/b.mp3');
    expect(inner.stopCalls).toBe(1);
  });

  it('reports null rather than NaN before a valid src lands', () => {
    // The whole reason the guard exists: `currentTime` is undefined until a valid src is set, and
    // `NaN >= lengthS - XFADE_S` is false forever — a loop that silently never wraps again.
    const { deck, inner } = makeWxDeck();
    deck.play('/a.mp3');
    expect(inner.currentTime).toBeNaN();
    expect(deck.position()).toBeNull();
    inner.currentTime = 7;
    expect(deck.position()).toBe(7);
  });

  it('stops, pauses and resumes only while playing', () => {
    const { deck, inner } = makeWxDeck();
    deck.setPaused(true);
    expect(inner.pauseCalls).toBe(0);

    deck.play('/a.mp3');
    deck.setPaused(true);
    expect(inner.pauseCalls).toBe(1);
    deck.setPaused(false);
    expect(inner.playCalls).toBe(2);

    deck.stop();
    expect(inner.stopCalls).toBe(1);
    deck.stop();
    expect(inner.stopCalls).toBe(1);
    expect(deck.position()).toBeNull();
  });

  it('reports the errMsg the widened wx.d.ts declaration finally makes reachable', () => {
    const { deck, inner, warns } = makeWxDeck();
    deck.play('/packs/music/a.mp3');
    inner.fail('errMsg: file not found');
    expect(deck.position()).toBeNull();
    expect(warns.some((w) => w.includes('/packs/music/a.mp3'))).toBe(true);
  });
});
