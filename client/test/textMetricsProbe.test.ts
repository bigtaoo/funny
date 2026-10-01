// Coverage for `client/src/render/textMetricsProbe.ts` — the shared measuring routine behind the
// WeChat-vs-Chrome text-metrics comparison (entries/wechat-probe.ts, test/browser/textMetrics.spec.ts).
//
// Both of its callers are outside the coverage suite (a WeChat entry and a Playwright spec), so it
// sat at 0% while being the one place where a mistake corrupts a conclusion rather than a screen:
// the report is read once, by a person, to decide whether `fitFont`'s one-shot division holds on a
// runtime. A linearity spread taken against the mean instead of the median, or an error path that
// returns `ok: true` with half the samples, would produce a plausible-looking report that says the
// wrong thing. (Code-point vs UTF-16 counting is NOT pinned: every corpus string is BMP, so the two
// agree and a case claiming to distinguish them would pass either way.)
//
// Driven with a fake 2D context whose `measureText` is a function the case chooses, so every
// number in the report is known in advance.
import { describe, it, expect } from 'vitest';

import {
  probeTextMetrics, PROBE_STRINGS, PROBE_SIZES, PROBE_FONT_FAMILY,
} from '../src/render/textMetricsProbe';

/** A context whose advance is `perChar(size, ch)` summed over code points. */
function ctxWith(
  perChar: (size: number, ch: string) => number,
  extra: Partial<{ ascent: number; descent: number; fontEcho: unknown }> = {},
): CanvasRenderingContext2D {
  let size = 0;
  let font = '';
  const ctx = {
    get font() { return ('fontEcho' in extra ? extra.fontEcho : font) as string; },
    set font(v: string) { font = v; size = Number(/^(\d+)px/.exec(v)![1]); },
    measureText(text: string) {
      const width = [...text].reduce((w, ch) => w + perChar(size, ch), 0);
      return {
        width,
        ...(extra.ascent !== undefined ? { actualBoundingBoxAscent: extra.ascent } : {}),
        ...(extra.descent !== undefined ? { actualBoundingBoxDescent: extra.descent } : {}),
      } as TextMetrics;
    },
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

const half = (size: number) => size * 0.5;

describe('probeTextMetrics', () => {
  it('measures every corpus row at every size, in size-major order', () => {
    const r = probeTextMetrics(() => ctxWith(half));
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.fontFamily).toBe(PROBE_FONT_FAMILY);
    expect(r.samples).toHaveLength(PROBE_SIZES.length * PROBE_STRINGS.length);
    expect(r.samples.slice(0, PROBE_STRINGS.length).map((s) => s.fontSize))
      .toEqual(PROBE_STRINGS.map(() => PROBE_SIZES[0]));
    expect(r.samples.map((s) => s.label).slice(0, PROBE_STRINGS.length))
      .toEqual(PROBE_STRINGS.map((p) => p.label));
  });

  it('records the font the context reports after the FIRST assignment', () => {
    const r = probeTextMetrics(() => ctxWith(half));
    expect(r.resolvedFont).toBe(`${PROBE_SIZES[0]}px ${PROBE_FONT_FAMILY}`);
  });

  it('records null when the context reports a non-string font', () => {
    const r = probeTextMetrics(() => ctxWith(half, { fontEcho: 42 }));
    expect(r.resolvedFont).toBeNull();
  });

  it('a linear half-width face gives ratio 0.5 everywhere and zero spread', () => {
    const r = probeTextMetrics(() => ctxWith(half));
    for (const s of r.samples) expect(s.advanceRatio).toBe(0.5);
    expect(r.linearity).toHaveLength(PROBE_STRINGS.length);
    for (const l of r.linearity) expect(l).toEqual({ label: l.label, medianRatio: 0.5, maxDeviation: 0 });
  });

  it('a proportional fallback shows up as latinWide and latinNarrow disagreeing', () => {
    const r = probeTextMetrics(() => ctxWith((size, ch) => size * (ch === 'M' ? 0.8 : ch === 'i' ? 0.25 : 0.5)));
    const at = (label: string) => r.linearity.find((l) => l.label === label)!.medianRatio;
    expect(at('latinWide')).toBe(0.8);
    expect(at('latinNarrow')).toBe(0.25);
  });

  it('spread is measured against the MEDIAN ratio, so one hinted size cannot drag the baseline', () => {
    // Advance is 0.5·size except at 7px, where it is rounded up to a whole 4px.
    const r = probeTextMetrics(() => ctxWith((size) => (size === 7 ? 4 : size * 0.5)));
    const l = r.linearity.find((x) => x.label === 'digits')!;
    expect(l.medianRatio).toBe(0.5);
    expect(l.maxDeviation).toBe(Number((Math.abs(4 / 7 - 0.5) / 0.5).toFixed(4)));
  });

  it('a zero-width face reports zero spread instead of NaN', () => {
    const r = probeTextMetrics(() => ctxWith(() => 0));
    expect(r.ok).toBe(true);
    for (const l of r.linearity) expect(l.maxDeviation).toBe(0);
  });

  it('records bounding-box metrics when present and null when the runtime lacks them', () => {
    const withBox = probeTextMetrics(() => ctxWith(half, { ascent: 9.12345, descent: 2 }));
    expect(withBox.samples[0]).toMatchObject({ ascent: 9.123, descent: 2 });
    const without = probeTextMetrics(() => ctxWith(half));
    expect(without.samples[0]).toMatchObject({ ascent: null, descent: null });
  });

  describe('failure paths say what failed and never claim ok', () => {
    it('factory throws', () => {
      const r = probeTextMetrics(() => { throw new Error('no canvas'); });
      expect(r.ok).toBe(false);
      expect(r.error).toBe('context factory threw: Error: no canvas');
      expect(r.samples).toEqual([]);
    });

    it('factory returns null', () => {
      const r = probeTextMetrics(() => null);
      expect(r).toMatchObject({ ok: false, error: 'context factory returned null' });
    });

    it('context without measureText', () => {
      const r = probeTextMetrics(() => ({}) as unknown as CanvasRenderingContext2D);
      expect(r).toMatchObject({ ok: false, error: 'context has no measureText' });
    });

    it('setting font throws', () => {
      const ctx = {
        set font(_v: string) { throw new Error('read-only'); },
        measureText: () => ({ width: 1 }),
      } as unknown as CanvasRenderingContext2D;
      const r = probeTextMetrics(() => ctx);
      expect(r).toMatchObject({ ok: false, error: 'setting ctx.font threw: Error: read-only' });
    });

    it('measureText throws mid-run: keeps the samples taken so far and names where it stopped', () => {
      const base = ctxWith(half);
      const ctx = {
        get font() { return base.font; },
        set font(v: string) { base.font = v; },
        measureText(text: string) {
          if (base.font.startsWith('11px') && text === PROBE_STRINGS[2]!.text) throw new Error('boom');
          return base.measureText(text);
        },
      } as unknown as CanvasRenderingContext2D;
      const r = probeTextMetrics(() => ctx);
      expect(r.ok).toBe(false);
      expect(r.error).toBe(`measureText threw at 11px on ${PROBE_STRINGS[2]!.label}: Error: boom`);
      expect(r.samples).toHaveLength(PROBE_STRINGS.length + 2);
      expect(r.linearity).toEqual([]);
    });
  });
});
