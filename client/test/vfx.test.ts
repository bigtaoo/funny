/**
 * vfx.test.ts — pure-core coverage for the data-driven VFX layer.
 *
 * Scope follows vitest.config.ts: only PIXI-free units are tested here —
 * sampleParam (track evaluation) and parseEffectDef (validation gate). The
 * render-layer files (interpret/primitives) depend on PIXI and are verified by
 * in-game visual regression (design §校验/容错, §测试策略).
 */
import { describe, it, expect, vi } from 'vitest';
import { sampleParam, applyEase } from '../src/render/vfx/sampleParam';
import { parseEffectDef } from '../src/render/vfx/parseEffectDef';

describe('sampleParam', () => {
  it('returns fallback for null/undefined', () => {
    expect(sampleParam(undefined, 0.5, 7)).toBe(7);
  });

  it('returns constants verbatim', () => {
    expect(sampleParam(2, 0.5)).toBe(2);
  });

  it('lerps a two-point linear ramp', () => {
    expect(sampleParam({ from: 0, to: 10 }, 0)).toBe(0);
    expect(sampleParam({ from: 0, to: 10 }, 0.5)).toBe(5);
    expect(sampleParam({ from: 0, to: 10 }, 1)).toBe(10);
  });

  it('applies easing on a ramp', () => {
    // easeOut at t=0.5 → 1-(0.5)^2 = 0.75
    expect(sampleParam({ from: 0, to: 100, ease: 'easeOut' }, 0.5)).toBeCloseTo(75);
  });

  it('clamps and interpolates multi-keyframe curves', () => {
    const kf = [{ t: 0, v: 0 }, { t: 0.6, v: 30 }, { t: 1, v: 10 }];
    expect(sampleParam(kf, 0)).toBe(0);     // at/under first
    expect(sampleParam(kf, -1)).toBe(0);    // before first → first.v
    expect(sampleParam(kf, 0.3)).toBeCloseTo(15);  // midway of segment 0→0.6
    expect(sampleParam(kf, 0.6)).toBe(30);  // exact keyframe
    expect(sampleParam(kf, 2)).toBe(10);    // beyond last → last.v
  });

  it('applyEase endpoints are stable', () => {
    for (const e of ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const) {
      expect(applyEase(e, 0)).toBeCloseTo(0);
      expect(applyEase(e, 1)).toBeCloseTo(1);
    }
  });
});

describe('parseEffectDef', () => {
  const ok = {
    schemaVersion: 1, id: 'x', duration: 0.25, layers: [
      { type: 'ring', params: { radius: { from: 0, to: 26 }, alpha: { from: 1, to: 0 }, lineWidth: 2 } },
    ],
  };

  it('accepts and normalizes a valid effect', () => {
    const def = parseEffectDef(ok, 'x.json');
    expect(def.id).toBe('x');
    expect(def.loop).toBe(false);
    expect(def.sfxKey).toBeNull();
    expect(def.layers).toHaveLength(1);
  });

  it('throws on missing id / bad duration / non-array layers', () => {
    expect(() => parseEffectDef({ duration: 1, layers: [] }, 's')).toThrow();
    expect(() => parseEffectDef({ id: 'a', duration: 0, layers: [] }, 's')).toThrow();
    expect(() => parseEffectDef({ id: 'a', duration: 1, layers: {} }, 's')).toThrow();
  });

  it('throws on malformed param track', () => {
    const bad = { id: 'a', duration: 1, layers: [{ type: 'ring', params: { radius: { from: 0 } } }] };
    expect(() => parseEffectDef(bad, 's')).toThrow();
  });

  it('drops a layer with an unknown primitive (warns, does not throw)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const def = parseEffectDef(
      { id: 'a', duration: 1, layers: [{ type: 'ring' }, { type: 'nope' }] }, 's',
    );
    expect(def.layers).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('defaults an unknown ease to linear with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const def = parseEffectDef(
      { id: 'a', duration: 1, layers: [{ type: 'ring', params: { radius: { from: 0, to: 1, ease: 'boing' } } }] },
      's',
    );
    const track = def.layers[0].params!.radius as { ease: string };
    expect(track.ease).toBe('linear');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('preserves layer z for draw-order control', () => {
    const def = parseEffectDef(
      { id: 'a', duration: 1, layers: [{ type: 'ring', z: 5 }] }, 's',
    );
    expect(def.layers[0].z).toBe(5);
  });
});
