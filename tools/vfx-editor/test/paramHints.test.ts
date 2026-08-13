// paramHints.ts — editor-side knowledge of which numeric knobs each primitive reads (for the
// ParamPanel "+ add param" dropdown) + sensible defaults. Fully pure data/lookup, no PIXI/DOM.
import { describe, it, expect } from 'vitest';
import { PrimitiveType } from '@vfx/types';
import {
  PARAM_HINTS,
  COUNT_PRIMITIVES,
  POINTS_PRIMITIVES,
  EMITTER_PRIMITIVES,
  ALL_PRIMITIVES,
  defaultParamValue,
} from '../src/model/paramHints';

describe('ALL_PRIMITIVES / PARAM_HINTS', () => {
  it('ALL_PRIMITIVES and PARAM_HINTS agree on the exact same set of primitive types', () => {
    expect(new Set(ALL_PRIMITIVES)).toEqual(new Set(Object.keys(PARAM_HINTS)));
  });

  it('every primitive has at least one hinted param', () => {
    for (const type of ALL_PRIMITIVES) {
      expect(PARAM_HINTS[type].length).toBeGreaterThan(0);
    }
  });

  it('every non-emitter primitive hints boilAmp (the shared "boil" wobble knob)', () => {
    for (const type of ALL_PRIMITIVES) {
      if (type === 'emitter') continue;
      expect(PARAM_HINTS[type]).toContain('boilAmp');
    }
  });
});

describe('the three layer-level-field membership sets partition ALL_PRIMITIVES', () => {
  it('COUNT_PRIMITIVES is exactly spokes/burst/dots/emitter', () => {
    expect(COUNT_PRIMITIVES).toEqual(new Set<PrimitiveType>(['spokes', 'burst', 'dots', 'emitter']));
  });
  it('POINTS_PRIMITIVES is exactly polyline', () => {
    expect(POINTS_PRIMITIVES).toEqual(new Set<PrimitiveType>(['polyline']));
  });
  it('EMITTER_PRIMITIVES is exactly emitter', () => {
    expect(EMITTER_PRIMITIVES).toEqual(new Set<PrimitiveType>(['emitter']));
  });
  it('ring/arc use none of the three layer-level fields', () => {
    for (const type of ['ring', 'arc'] as PrimitiveType[]) {
      expect(COUNT_PRIMITIVES.has(type)).toBe(false);
      expect(POINTS_PRIMITIVES.has(type)).toBe(false);
      expect(EMITTER_PRIMITIVES.has(type)).toBe(false);
    }
  });
  it('emitter is the only primitive claimed by more than one set (it uses both count and emitter)', () => {
    for (const type of ALL_PRIMITIVES) {
      const claims = [COUNT_PRIMITIVES.has(type), POINTS_PRIMITIVES.has(type), EMITTER_PRIMITIVES.has(type)].filter(Boolean).length;
      expect(claims).toBeLessThanOrEqual(type === 'emitter' ? 2 : 1);
    }
  });
});

describe('defaultParamValue', () => {
  it('returns the curated starting value for known param names', () => {
    expect(defaultParamValue('alpha')).toBe(1);
    expect(defaultParamValue('lineWidth')).toBe(2);
    expect(defaultParamValue('scale')).toBe(1);
    expect(defaultParamValue('dotSize')).toBe(2);
    expect(defaultParamValue('size')).toBe(4);
    expect(defaultParamValue('sweep')).toBe(Math.PI);
    expect(defaultParamValue('emphasisLineWidth')).toBe(4);
    expect(defaultParamValue('boilAmp')).toBe(1.5);
  });

  it('falls back to 0 for an unrecognized name (e.g. a free-typed custom param)', () => {
    expect(defaultParamValue('customKnob')).toBe(0);
    expect(defaultParamValue('')).toBe(0);
  });
});
