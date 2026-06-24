/**
 * paramHints.ts — editor-side knowledge of which numeric knobs each primitive
 * reads, for the ParamPanel "+ add param" dropdown and sensible defaults.
 *
 * NOT a source of truth for interpretation — primitives.ts (game side) is. These
 * are only UI hints; a user can still add an arbitrary param name by typing.
 * Keep in sync with client/src/render/vfx/primitives.ts when knobs change.
 */
import { PrimitiveType } from '@vfx/types';

/** Param names each primitive samples (excludes layer-level fields count/points). */
export const PARAM_HINTS: Record<PrimitiveType, string[]> = {
  ring:     ['radius', 'alpha', 'lineWidth', 'boilAmp'],
  arc:      ['radius', 'alpha', 'lineWidth', 'startAngle', 'sweep', 'boilAmp'],
  spokes:   ['innerR', 'outerR', 'alpha', 'rotation', 'lineWidth', 'emphasisEvery', 'emphasisLineWidth', 'boilAmp'],
  burst:    ['nearR', 'farR', 'alpha', 'rotation', 'lineWidth', 'boilAmp'],
  dots:     ['spreadR', 'dotSize', 'alpha', 'angleOffset', 'jitter', 'boilAmp'],
  polyline: ['alpha', 'lineWidth', 'scale', 'rotation', 'translateX', 'translateY', 'boilAmp'],
  emitter:  [],
};

/** Primitives that use the layer-level `count` field. */
export const COUNT_PRIMITIVES: ReadonlySet<PrimitiveType> = new Set<PrimitiveType>([
  'spokes', 'burst', 'dots',
]);

/** Primitives that use the layer-level `points` field. */
export const POINTS_PRIMITIVES: ReadonlySet<PrimitiveType> = new Set<PrimitiveType>([
  'polyline',
]);

export const ALL_PRIMITIVES: PrimitiveType[] = [
  'ring', 'arc', 'spokes', 'dots', 'burst', 'polyline', 'emitter',
];

/** A reasonable starting value for a freshly-added param, by name. */
export function defaultParamValue(name: string): number {
  switch (name) {
    case 'alpha':             return 1;
    case 'lineWidth':         return 2;
    case 'scale':             return 1;
    case 'dotSize':           return 2;
    case 'sweep':             return Math.PI;
    case 'emphasisLineWidth': return 4;
    case 'boilAmp':           return 1.5;
    default:                  return 0;
  }
}
