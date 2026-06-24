/**
 * vfx/types.ts — data model for declarative, code-free visual effects.
 *
 * An effect is a list of layers; each layer is one vector primitive whose
 * numeric knobs ("params") are driven by normalized progress t (0 → 1).
 * The runtime interpreter (interpret.ts) and the (future) vfx-editor both
 * consume these types — single source of truth.
 *
 * Design doc: design/tools/vfx-editor/DESIGN.md
 */

/** Easing curves understood by sampleParam. */
export type Ease = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

/** One stop in a multi-keyframe track; `ease` governs the segment ENDING here. */
export interface Keyframe {
  t: number;
  v: number;
  ease?: Ease;
}

/**
 * A numeric parameter over the effect lifetime, in three interchangeable forms:
 *   • number              — constant.
 *   • {from,to,ease}      — two-point ramp (the common case).
 *   • Keyframe[]          — multi-keyframe curve.
 */
export type ParamTrack =
  | number
  | { from: number; to: number; ease?: Ease }
  | Keyframe[];

/** Hand-drawn "boil" wobble for a layer (baked variants cycled at fps). P3. */
export interface BoilSpec {
  variants?: number; // default 3
  fps?: number;      // default 8
}

export type PrimitiveType =
  | 'ring'
  | 'arc'
  | 'spokes'
  | 'dots'
  | 'burst'
  | 'polyline'
  | 'emitter'; // reserved, not implemented this phase (§9)

/**
 * A single drawable layer. `params` holds every numeric knob (constants are
 * just numbers); structural fields live at layer level.
 */
export interface LayerDef {
  type: PrimitiveType;
  /** Repeat count for radial primitives (spokes/burst/dots). Default 1. */
  count?: number;
  /** Optional seed for this layer's jitter/boil; derived from effect id + index if absent. */
  seed?: number;
  /** Draw order within the effect; lower = drawn first (under). Default = array index. */
  z?: number;
  /** Hand-drawn wobble (P3). */
  boil?: BoilSpec;
  /** Animated/constant numeric knobs, keyed by name (radius, alpha, lineWidth, …). */
  params?: Record<string, ParamTrack>;
  /** polyline geometry, in design pixels, before scale/rotation/translate. */
  points?: Array<[number, number]>;
}

export interface EffectDef {
  schemaVersion?: number;
  /** Unique key used by VFXSystem.play(id, …). */
  id: string;
  /** Total play time in seconds. t = elapsed / duration (clamped to 1). */
  duration: number;
  /** true → loop forever until stop(handle); false/absent → one-shot. */
  loop?: boolean;
  /** Fallback colour when play() omits one. Accepts number or "0xRRGGBB" string. */
  defaultColor?: string | number;
  /** Placeholder for future AUDIO_DESIGN linkage; not consumed this phase. */
  sfxKey?: string | null;
  layers: LayerDef[];
}
